/**
 * IPC handlers. Every renderer-reachable operation lives here, and each one
 * validates its inputs — the renderer is treated as untrusted, so a bad or
 * malicious path can never make the main process read or write outside the
 * configured library root.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type {
  AppSettings,
  Bookmark,
  ClassRecord,
  ExportOptions,
  GlossaryTerm,
  LectureRecord,
  ProviderAvailability,
  SearchHit,
  SuggestionStatus,
  TranscriptFile,
  TranscriptionQueueSnapshot
} from '@shared/types'
import { CLIPBOARD_SOFT_LIMIT, DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { AUDIO_PROTOCOL, IPC } from '@shared/ipc'
import { EXPORT_FORMATS, isExportFormat, type ClassExportResult } from '@shared/exportFormats'
import { sanitizeSegment } from '@shared/naming'
import { editSegmentText, revertSegmentEdit, setSpeakerName, toPlainText, toSections } from '@shared/transcript'
import type { Repos } from './db/repos'
import type { SettingsStore } from './storage/settings'
import { getDiskEncryptionHint } from './storage/settings'
import { getDiskSpace } from './diskSpace'
import { isInside, lecturePaths, readJson, writeJsonAtomic } from './storage/paths'
import {
  createClass,
  createLecture,
  deleteClass,
  deleteLecture,
  importGlossaryFromDisk,
  indexLectureTranscript,
  moveLecture,
  renameClass,
  renameLecture,
  syncGlossaryToDisk
} from './library'
import type { RecordingController } from './recordingController'
import { rescanLibrary, type RescanReport } from './rescan'
import type { HotkeyManager, HotkeyName, HotkeyStatus } from './hotkey'
import { addBookmark, readBookmarks, removeBookmark, updateBookmark } from './bookmarks'
import { loadTranscriptFile, updateTranscript } from './transcriptStore'
import {
  exportFileName,
  exportLecturesToFolder,
  lectureFolderExportPath,
  loadExportItem,
  renderClass,
  renderLecture,
  writeExportFile,
  type ExportItem
} from './export/exporter'
import type { BatchTranscriber } from './transcription/types'
import { verifyLectureSegments } from './transcription/pipeline'
import { isAudioArchive, segmentAbsolutePath, type SegmentManifest } from './audio/recordingSession'
import { IMPORT_EXTENSIONS } from '@shared/importFormats'

export interface IpcDeps {
  repos: Repos
  settings: SettingsStore
  controller: RecordingController
  transcribers: () => BatchTranscriber[]
  broadcast: (channel: string, payload: unknown) => void
  hotkey: () => HotkeyManager | null
}

export function registerIpc(deps: IpcDeps): void {
  const { repos, settings, controller } = deps

  /** Resolve a class, or fail loudly rather than silently doing nothing. */
  const requireClass = (id: unknown): ClassRecord => {
    if (typeof id !== 'string') throw new Error('A class id is required.')
    const found = repos.classes.get(id)
    if (!found) throw new Error('That class no longer exists.')
    return found
  }

  const requireLecture = (id: unknown): LectureRecord => {
    if (typeof id !== 'string') throw new Error('A lecture id is required.')
    const found = repos.lectures.get(id)
    if (!found) throw new Error('That lecture no longer exists.')
    return found
  }

  /** Refuse to touch anything outside the configured library root. */
  const assertInRoot = (target: string): void => {
    const root = settings.get().rootDir
    if (!isInside(root, target)) {
      throw new Error('Refusing to access a path outside the library folder.')
    }
  }

  // --- settings ------------------------------------------------------------

  ipcMain.handle(IPC.settingsGet, (): AppSettings => settings.get())

  ipcMain.handle(IPC.settingsUpdate, (_e, patch: Partial<AppSettings>): AppSettings => {
    if (controller.isRecording && patch.segmentSeconds !== undefined) {
      throw new Error('Segment length cannot be changed while recording.')
    }
    return settings.update(patch)
  })

  ipcMain.handle(IPC.settingsProviders, async (): Promise<ProviderAvailability[]> =>
    Promise.all(deps.transcribers().map((t) => t.checkAvailability()))
  )

  ipcMain.handle(IPC.settingsSetApiKey, (_e, provider: 'deepgram', key: string | null): boolean => {
    settings.setApiKey(provider, key)
    return settings.hasApiKey(provider)
  })

  ipcMain.handle(IPC.settingsHasApiKey, (_e, provider: 'deepgram'): boolean => settings.hasApiKey(provider))

  ipcMain.handle(IPC.settingsDiskEncryption, () => getDiskEncryptionHint())

  // How much recording space is left, for the low-disk warning.
  ipcMain.handle(IPC.systemDiskSpace, () => getDiskSpace(settings.get().rootDir))

  ipcMain.handle(IPC.settingsChooseRoot, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
      title: 'Choose where lectures are stored',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    settings.update({ rootDir: result.filePaths[0] })
    return result.filePaths[0]
  })

  const hotkeyName = (value: unknown): HotkeyName => (value === 'bookmark' ? 'bookmark' : 'record')
  const storedHotkey = (name: HotkeyName): string =>
    name === 'bookmark' ? settings.get().bookmarkHotkey : settings.get().recordHotkey

  ipcMain.handle(IPC.settingsHotkeyStatus, (_e, name?: string): HotkeyStatus => {
    const which = hotkeyName(name)
    const manager = deps.hotkey()
    return manager
      ? manager.getStatus(which)
      : { accelerator: storedHotkey(which), registered: false, detail: 'Shortcuts are unavailable.' }
  })

  // Applies immediately rather than on next launch, and reports whether the
  // combination was actually accepted.
  ipcMain.handle(IPC.settingsSetHotkey, (_e, accelerator: string, name?: string): HotkeyStatus => {
    const which = hotkeyName(name)
    const manager = deps.hotkey()
    if (!manager) throw new Error('Shortcuts are unavailable in this session.')
    const status = manager.apply(which, String(accelerator ?? ''))
    // Persist whatever the student typed, so a rejected shortcut is still shown
    // back to them to fix rather than silently reverting.
    settings.update(which === 'bookmark' ? { bookmarkHotkey: status.accelerator } : { recordHotkey: status.accelerator })
    return status
  })

  // --- library sync --------------------------------------------------------

  ipcMain.handle(IPC.libraryRescan, async (): Promise<RescanReport> => {
    const report = await rescanLibrary(repos, settings.get().rootDir, {
      protectLectureId: controller.currentLectureId
    })
    deps.broadcast(IPC.evtLibraryChanged, { rescan: report })
    return report
  })

  // --- classes -------------------------------------------------------------

  ipcMain.handle(IPC.classesList, (): ClassRecord[] => repos.classes.list())

  ipcMain.handle(
    IPC.classCreate,
    async (_e, input: { name: string; instructor?: string | null; color?: string | null }): Promise<ClassRecord> => {
      if (!input?.name?.trim()) throw new Error('A class name is required.')
      return createClass(repos, settings.get().rootDir, input)
    }
  )

  ipcMain.handle(
    IPC.classUpdate,
    async (_e, id: string, patch: { instructor?: string | null; color?: string | null }): Promise<ClassRecord> => {
      const klass = requireClass(id)
      // The folder name is the class identity on disk; renaming it is a move
      // operation we deliberately don't perform implicitly.
      repos.classes.update(klass.id, { instructor: patch.instructor, color: patch.color })
      return repos.classes.get(klass.id)!
    }
  )

  /** Refuse any structural change that would move the folder being recorded into. */
  const assertNotRecording = (message: string): void => {
    if (controller.isRecording) throw new Error(message)
  }

  /** A running transcriber holds a lecture's files open; moving them under it breaks the pass. */
  const assertNoTranscriptionRunningIn = (classId: string, message: string): void => {
    const running = controller.queue.snapshot().running
    if (!running) return
    if (repos.lectures.get(running.lectureId)?.classId === classId) throw new Error(message)
  }

  ipcMain.handle(IPC.classRename, async (_e, id: string, name: string): Promise<ClassRecord> => {
    const klass = requireClass(id)
    if (!name?.trim()) throw new Error('A class name is required.')
    assertNotRecording('Stop the current recording before renaming this class.')
    assertNoTranscriptionRunningIn(klass.id, 'Wait for the transcription in progress to finish before renaming this class.')
    if (repos.lectures.listByClass(klass.id).some((l) => controller.isImporting(l.id))) {
      throw new Error('Wait for the files being imported into this class to finish before renaming it.')
    }
    return renameClass(repos, settings.get().rootDir, klass, name)
  })

  ipcMain.handle(IPC.classDelete, async (_e, id: string, deleteFiles = false) => {
    const klass = requireClass(id)
    assertNotRecording('Stop the current recording before removing this class.')
    // Stop any transcription of this class's lectures first: a transcriber still
    // holding files open would make deleting the folder fail on Windows.
    for (const lecture of repos.lectures.listByClass(klass.id)) {
      await controller.cancelImport(lecture.id)
      await controller.cancelTranscription(lecture.id)
    }
    // Files are kept unless the caller explicitly asks otherwise: losing a
    // term's recordings to a stray click is not a recoverable mistake.
    return deleteClass(repos, settings.get().rootDir, klass, Boolean(deleteFiles))
  })

  // --- lectures ------------------------------------------------------------

  ipcMain.handle(IPC.lecturesByClass, (_e, classId: string): LectureRecord[] =>
    repos.lectures.listByClass(requireClass(classId).id)
  )

  ipcMain.handle(IPC.lecturesAll, (): LectureRecord[] => repos.lectures.listAll())

  ipcMain.handle(IPC.lectureGet, (_e, id: string): LectureRecord => requireLecture(id))

  ipcMain.handle(
    IPC.lectureCreate,
    async (_e, classId: string, input: { title?: string }): Promise<LectureRecord> =>
      createLecture(repos, requireClass(classId), { title: input?.title })
  )

  // Import audio or video files as new lectures. Paths come from a drop onto
  // the window; with none, the student picks files. Files are only ever read,
  // and what they become is written inside the library.
  ipcMain.handle(IPC.lectureImport, async (event, classId: string, filePaths?: unknown): Promise<LectureRecord[]> => {
    const klass = requireClass(classId)
    let sources = Array.isArray(filePaths)
      ? filePaths.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : []
    if (sources.length === 0) {
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
        title: `Import recordings into ${klass.name}`,
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Audio and video', extensions: [...IMPORT_EXTENSIONS] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (result.canceled) return []
      sources = result.filePaths
    }
    const started: LectureRecord[] = []
    for (const source of sources) started.push(await controller.importAudio(klass, source))
    return started
  })

  ipcMain.handle(IPC.lectureImportCancel, async (_e, lectureId: string): Promise<boolean> =>
    controller.cancelImport(String(lectureId ?? ''))
  )

  ipcMain.handle(IPC.lectureRename, async (_e, id: string, title: string): Promise<LectureRecord> => {
    const lecture = requireLecture(id)
    if (!title?.trim()) throw new Error('A lecture title is required.')
    if (controller.currentLectureId === lecture.id) {
      throw new Error('Stop the recording before renaming this lecture.')
    }
    if (controller.queue.isRunning(lecture.id)) {
      throw new Error('Wait for this lecture to finish transcribing before renaming it.')
    }
    if (controller.isImporting(lecture.id)) {
      throw new Error('Wait for this lecture to finish importing before renaming it.')
    }
    // Renames the folder too, so the on-disk name keeps matching the title.
    return renameLecture(repos, requireClass(lecture.classId), lecture, title)
  })

  ipcMain.handle(IPC.lectureMove, async (_e, id: string, targetClassId: string): Promise<LectureRecord> => {
    const lecture = requireLecture(id)
    if (controller.currentLectureId === lecture.id) {
      throw new Error('Stop the recording before moving this lecture.')
    }
    if (controller.queue.isRunning(lecture.id)) {
      throw new Error('Wait for this lecture to finish transcribing before moving it.')
    }
    if (controller.isImporting(lecture.id)) {
      throw new Error('Wait for this lecture to finish importing before moving it.')
    }
    return moveLecture(repos, lecture, requireClass(targetClassId))
  })

  ipcMain.handle(IPC.lectureDelete, async (_e, id: string, deleteFiles = false) => {
    const lecture = requireLecture(id)
    if (controller.currentLectureId === lecture.id) {
      throw new Error('Stop the recording before removing this lecture.')
    }
    // Cancelling an import already removes the half-made lecture it was creating.
    if (await controller.cancelImport(lecture.id)) {
      return { removedFromLibrary: true, filesDeleted: true, folder: lecture.dirPath }
    }
    await controller.cancelTranscription(lecture.id)
    return deleteLecture(repos, settings.get().rootDir, lecture, Boolean(deleteFiles))
  })

  ipcMain.handle(IPC.lectureSearch, (_e, query: string): SearchHit[] => {
    const hits: SearchHit[] = []
    for (const hit of repos.lectures.search(String(query ?? ''))) {
      const lecture = repos.lectures.get(hit.lectureId)
      if (lecture) hits.push({ lecture, snippet: hit.snippet, matches: hit.matches })
    }
    return hits
  })

  ipcMain.handle(IPC.lectureReveal, async (_e, id: string): Promise<void> => {
    const lecture = requireLecture(id)
    assertInRoot(lecture.dirPath)
    await shell.openPath(lecture.dirPath)
  })

  ipcMain.handle(IPC.lectureVerify, async (_e, id: string) => {
    const lecture = requireLecture(id)
    const outcome = await verifyLectureSegments(repos, lecture)
    repos.lectures.update(lecture.id, {
      segmentCount: outcome.verified.length + outcome.corrupt.length,
      corruptSegmentCount: outcome.corrupt.length
    })
    return outcome
  })

  // --- glossary ------------------------------------------------------------

  ipcMain.handle(IPC.glossaryList, (_e, classId: string): GlossaryTerm[] =>
    repos.glossary.listByClass(requireClass(classId).id)
  )

  ipcMain.handle(IPC.glossaryAdd, async (_e, classId: string, term: string, note: string | null) => {
    const klass = requireClass(classId)
    if (!term?.trim()) throw new Error('A term is required.')
    const saved = repos.glossary.add(klass.id, term, note ?? null)
    await syncGlossaryToDisk(repos, klass)
    return saved
  })

  ipcMain.handle(
    IPC.glossaryUpdate,
    async (_e, classId: string, id: string, patch: { term?: string; note?: string | null }) => {
      const klass = requireClass(classId)
      repos.glossary.update(id, patch)
      await syncGlossaryToDisk(repos, klass)
      return repos.glossary.listByClass(klass.id)
    }
  )

  ipcMain.handle(IPC.glossaryRemove, async (_e, classId: string, id: string) => {
    const klass = requireClass(classId)
    repos.glossary.remove(id)
    await syncGlossaryToDisk(repos, klass)
    return repos.glossary.listByClass(klass.id)
  })

  ipcMain.handle(IPC.glossaryImport, async (_e, classId: string, text: string) => {
    const klass = requireClass(classId)
    // One term per line, optional "term :: note".
    const terms = String(text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [term, note] = line.split('::').map((p) => p.trim())
        return { term: term ?? line, note: note ?? null }
      })
      .filter((t) => t.term.length > 0)

    for (const t of terms) repos.glossary.add(klass.id, t.term, t.note)
    await syncGlossaryToDisk(repos, klass)
    return repos.glossary.listByClass(klass.id)
  })

  // --- recording -----------------------------------------------------------

  ipcMain.handle(IPC.recordingStart, async (_e, classId: string, lectureId: string | null) => {
    const klass = requireClass(classId)
    const lecture = lectureId ? requireLecture(lectureId) : await createLecture(repos, klass, {})
    return controller.start(klass, lecture)
  })

  ipcMain.handle(IPC.recordingStop, async () => controller.stop())

  ipcMain.handle(IPC.recordingState, () => controller.getState())

  ipcMain.handle(IPC.recordingPause, async () => controller.pause())
  ipcMain.handle(IPC.recordingResume, () => controller.resume())
  ipcMain.handle(IPC.recordingBookmark, async (_e, note?: string): Promise<Bookmark> =>
    controller.addBookmark(typeof note === 'string' ? note : '')
  )

  // --- bookmarks -----------------------------------------------------------

  ipcMain.handle(IPC.bookmarksList, async (_e, lectureId: string): Promise<Bookmark[]> =>
    readBookmarks(requireLecture(lectureId).dirPath)
  )

  ipcMain.handle(
    IPC.bookmarksUpdate,
    async (_e, lectureId: string, id: string, note: string): Promise<Bookmark[]> =>
      updateBookmark(requireLecture(lectureId).dirPath, String(id), String(note ?? ''))
  )

  ipcMain.handle(IPC.bookmarksRemove, async (_e, lectureId: string, id: string): Promise<Bookmark[]> =>
    removeBookmark(requireLecture(lectureId).dirPath, String(id))
  )

  // --- transcription queue -------------------------------------------------

  ipcMain.handle(IPC.transcriptionQueue, (): TranscriptionQueueSnapshot => controller.queueSnapshot())

  ipcMain.handle(IPC.transcriptionCancel, async (_e, lectureId: string): Promise<boolean> =>
    controller.cancelTranscription(requireLecture(lectureId).id)
  )

  // Audio frames use `send`, not `invoke`: they are high-frequency and
  // fire-and-forget, and a per-frame round trip would add needless latency.
  ipcMain.on(IPC.recordingAudio, (_e, chunk: ArrayBuffer) => {
    controller.writeAudio(chunk)
  })

  // --- transcript ----------------------------------------------------------

  const loadTranscript = async (lecture: LectureRecord): Promise<TranscriptFile | null> =>
    (await loadTranscriptFile(lecture.dirPath))?.transcript ?? null

  ipcMain.handle(IPC.transcriptGet, async (_e, lectureId: string): Promise<TranscriptFile | null> =>
    loadTranscript(requireLecture(lectureId))
  )

  // Recording and transcription are independent, so a retry is fine while
  // another lecture is recording: it simply joins the queue.
  ipcMain.handle(IPC.transcriptRetry, async (_e, lectureId: string) =>
    controller.requestTranscription(requireLecture(lectureId).id, 'retry')
  )

  /** Keep search in step with what the transcript now says. */
  const reindexLecture = (lecture: LectureRecord, transcript: TranscriptFile): void => {
    const klass = repos.classes.get(lecture.classId)
    if (klass) indexLectureTranscript(repos, lecture.id, klass.name, lecture.title, transcript)
  }

  /** A pass that is queued or running replaces the transcript, and would throw these changes away. */
  const assertTranscriptEditable = (lecture: LectureRecord): void => {
    if (controller.queue.has(lecture.id)) {
      throw new Error(
        'This lecture is being transcribed again, which will replace its transcript. Make changes once that finishes.'
      )
    }
  }

  ipcMain.handle(
    IPC.transcriptSetSuggestion,
    async (_e, lectureId: string, suggestionId: string, status: SuggestionStatus): Promise<TranscriptFile> => {
      const lecture = requireLecture(lectureId)
      if (status !== 'accepted' && status !== 'rejected' && status !== 'pending') {
        throw new Error('Unknown suggestion status.')
      }
      assertTranscriptEditable(lecture)
      const transcript = await updateTranscript(lecture.dirPath, (current) => {
        if (!current.suggestions.some((s) => s.id === suggestionId)) {
          throw new Error('That suggestion no longer exists.')
        }
        return {
          ...current,
          updatedAt: new Date().toISOString(),
          suggestions: current.suggestions.map((s) => (s.id === suggestionId ? { ...s, status } : s))
        }
      })
      reindexLecture(lecture, transcript)
      deps.broadcast(IPC.evtLibraryChanged, { lectureId })
      return transcript
    }
  )

  // Correct a passage by hand. The original wording is kept so it can be restored.
  ipcMain.handle(
    IPC.transcriptEditSegment,
    async (_e, lectureId: string, segmentId: string, text: string): Promise<TranscriptFile> => {
      const lecture = requireLecture(lectureId)
      if (typeof segmentId !== 'string' || typeof text !== 'string') throw new Error('Nothing to save.')
      assertTranscriptEditable(lecture)
      const transcript = await updateTranscript(lecture.dirPath, (current) => editSegmentText(current, segmentId, text))
      reindexLecture(lecture, transcript)
      return transcript
    }
  )

  ipcMain.handle(IPC.transcriptRevertSegment, async (_e, lectureId: string, segmentId: string): Promise<TranscriptFile> => {
    const lecture = requireLecture(lectureId)
    if (typeof segmentId !== 'string') throw new Error('Nothing to restore.')
    assertTranscriptEditable(lecture)
    const transcript = await updateTranscript(lecture.dirPath, (current) => revertSegmentEdit(current, segmentId))
    reindexLecture(lecture, transcript)
    return transcript
  })

  ipcMain.handle(
    IPC.transcriptSetSpeakerName,
    async (_e, lectureId: string, speaker: string, name: string): Promise<TranscriptFile> => {
      const lecture = requireLecture(lectureId)
      if (typeof speaker !== 'string') throw new Error('Which speaker?')
      assertTranscriptEditable(lecture)
      return updateTranscript(lecture.dirPath, (current) => setSpeakerName(current, speaker, String(name ?? '')))
    }
  )

  // Bookmark a moment while listening back, not only while recording.
  ipcMain.handle(IPC.bookmarksAdd, async (_e, lectureId: string, atSec: number, note?: string): Promise<Bookmark[]> => {
    const lecture = requireLecture(lectureId)
    await addBookmark(lecture.dirPath, Number(atSec), String(note ?? ''))
    return readBookmarks(lecture.dirPath)
  })

  ipcMain.handle(IPC.transcriptAudioUrl, async (_e, lectureId: string): Promise<string | null> => {
    const lecture = requireLecture(lectureId)
    const paths = lecturePaths(lecture.dirPath)
    // Prefer the lecture's single archived file, then an assembled final.wav,
    // then the first segment, so a lecture that failed to transcribe is still
    // listenable.
    const candidates: string[] = []
    const archive = (await readJson<SegmentManifest>(paths.manifest))?.archive
    if (isAudioArchive(archive)) candidates.push(segmentAbsolutePath(lecture.dirPath, archive.relPath))
    candidates.push(paths.finalAudio)
    const segments = repos.segments.listByLecture(lecture.id)
    if (segments[0]) candidates.push(`${lecture.dirPath}/${segments[0].relPath}`)

    for (const candidate of candidates) {
      if (await fs.stat(candidate).then(() => true).catch(() => false)) {
        return `${AUDIO_PROTOCOL}://media/${encodeURIComponent(candidate)}`
      }
    }
    return null
  })

  // --- export --------------------------------------------------------------

  const requireTranscript = async (lectureId: string): Promise<{ lecture: LectureRecord; transcript: TranscriptFile }> => {
    const lecture = requireLecture(lectureId)
    const transcript = await loadTranscript(lecture)
    if (!transcript) throw new Error('This lecture has no transcript yet.')
    return { lecture, transcript }
  }

  const windowFor = (event: IpcMainInvokeEvent): BrowserWindow =>
    BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getAllWindows()[0]!

  // Save a lecture in any format: into its own folder, or wherever the student
  // chooses. Resolves to the saved path, or null if the dialog was cancelled.
  ipcMain.handle(
    IPC.exportLecture,
    async (
      event,
      lectureId: string,
      format: unknown,
      options?: Partial<ExportOptions>,
      destination?: unknown
    ): Promise<string | null> => {
      const lecture = requireLecture(lectureId)
      if (!isExportFormat(format)) throw new Error('Unknown export format.')
      const item = await loadExportItem(lecture)
      if (!item) throw new Error('This lecture has no transcript yet.')
      const merged = { ...DEFAULT_EXPORT_OPTIONS, ...options }

      let target: string
      if (destination === 'choose') {
        const info = EXPORT_FORMATS[format]
        const result = await dialog.showSaveDialog(windowFor(event), {
          title: `Export “${lecture.title}”`,
          defaultPath: path.join(app.getPath('documents'), exportFileName(lecture.title, format)),
          filters: [{ name: info.label, extensions: [info.extension] }]
        })
        if (result.canceled || !result.filePath) return null
        target = result.filePath
      } else {
        target = lectureFolderExportPath(lecture.dirPath, format)
        assertInRoot(target)
      }
      await writeExportFile(target, await renderLecture(format, item, merged))
      return target
    }
  )

  // Export every transcribed lecture in a class, as one file or one per lecture.
  ipcMain.handle(
    IPC.exportClass,
    async (
      event,
      classId: string,
      format: unknown,
      options?: Partial<ExportOptions>,
      layout?: unknown
    ): Promise<ClassExportResult | null> => {
      const klass = requireClass(classId)
      if (!isExportFormat(format)) throw new Error('Unknown export format.')
      const info = EXPORT_FORMATS[format]
      const single = layout === 'single'
      if (single && !info.combinable) throw new Error(`${info.label} can only be exported as one file per lecture.`)

      const lectures = repos.lectures.listByClass(klass.id)
      const items = (await Promise.all(lectures.map((lecture) => loadExportItem(lecture)))).filter(
        (item): item is ExportItem => item !== null
      )
      if (items.length === 0) throw new Error('None of the lectures in this class has a transcript yet.')
      const merged = { ...DEFAULT_EXPORT_OPTIONS, ...options }
      const skipped = lectures.length - items.length
      const win = windowFor(event)

      if (single) {
        const result = await dialog.showSaveDialog(win, {
          title: `Export ${klass.name}`,
          defaultPath: path.join(app.getPath('documents'), exportFileName(klass.name, format)),
          filters: [{ name: info.label, extensions: [info.extension] }]
        })
        if (result.canceled || !result.filePath) return null
        await writeExportFile(result.filePath, await renderClass(format, klass.name, items, merged))
        shell.showItemInFolder(result.filePath)
        return { path: result.filePath, exported: items.length, skipped }
      }

      const result = await dialog.showOpenDialog(win, {
        title: `Choose where to save ${klass.name}`,
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths[0]) return null
      const folder = path.join(
        result.filePaths[0],
        sanitizeSegment(`${klass.name} - ${info.extension.toUpperCase()}`, klass.name)
      )
      const written = await exportLecturesToFolder(folder, items, format, merged)
      if (written[0]) shell.showItemInFolder(written[0])
      return { path: folder, exported: written.length, skipped }
    }
  )

  ipcMain.handle(
    IPC.exportClipboard,
    async (
      _e,
      lectureId: string,
      options?: Partial<ExportOptions>
    ): Promise<{ copied: boolean; length: number; sections?: { label: string; text: string }[] }> => {
      const { transcript } = await requireTranscript(lectureId)
      const merged = { ...DEFAULT_EXPORT_OPTIONS, ...options }
      const text = toPlainText(transcript, merged)

      if (text.length > CLIPBOARD_SOFT_LIMIT) {
        // Too long to be useful as one blob — hand back sections instead.
        return { copied: false, length: text.length, sections: toSections(transcript, merged) }
      }
      clipboard.writeText(text)
      return { copied: true, length: text.length }
    }
  )
}

/** Copy an arbitrary string (one transcript section) to the clipboard. */
export function registerClipboardSection(): void {
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
}
