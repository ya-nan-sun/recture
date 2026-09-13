/**
 * IPC handlers. Every renderer-reachable operation lives here, and each one
 * validates its inputs — the renderer is treated as untrusted, so a bad or
 * malicious path can never make the main process read or write outside the
 * configured library root.
 */

import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import * as fs from 'node:fs/promises'
import type {
  AppSettings,
  ClassRecord,
  ExportOptions,
  GlossaryTerm,
  LectureRecord,
  ProviderAvailability,
  SuggestionStatus,
  TranscriptFile
} from '@shared/types'
import { CLIPBOARD_SOFT_LIMIT, DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { AUDIO_PROTOCOL, IPC } from '@shared/ipc'
import { toPlainText, toSections } from '@shared/transcript'
import type { Repos } from './db/repos'
import type { SettingsStore } from './storage/settings'
import { getDiskEncryptionHint } from './storage/settings'
import { isInside, lecturePaths, readJson, writeJsonAtomic } from './storage/paths'
import {
  createClass,
  createLecture,
  deleteClass,
  deleteLecture,
  importGlossaryFromDisk,
  moveLecture,
  renameClass,
  renameLecture,
  syncGlossaryToDisk
} from './library'
import type { RecordingController } from './recordingController'
import { rescanLibrary, type RescanReport } from './rescan'
import { transcriptToMarkdown } from './export/markdown'
import { transcriptToPdf } from './export/pdf'
import type { BatchTranscriber } from './transcription/types'
import { verifyLectureSegments } from './transcription/pipeline'

export interface IpcDeps {
  repos: Repos
  settings: SettingsStore
  controller: RecordingController
  transcribers: () => BatchTranscriber[]
  broadcast: (channel: string, payload: unknown) => void
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

  ipcMain.handle(IPC.classRename, async (_e, id: string, name: string): Promise<ClassRecord> => {
    const klass = requireClass(id)
    if (!name?.trim()) throw new Error('A class name is required.')
    assertNotRecording('Stop the current recording before renaming this class.')
    return renameClass(repos, settings.get().rootDir, klass, name)
  })

  ipcMain.handle(IPC.classDelete, async (_e, id: string, deleteFiles = false) => {
    const klass = requireClass(id)
    assertNotRecording('Stop the current recording before removing this class.')
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

  ipcMain.handle(IPC.lectureRename, async (_e, id: string, title: string): Promise<LectureRecord> => {
    const lecture = requireLecture(id)
    if (!title?.trim()) throw new Error('A lecture title is required.')
    if (controller.currentLectureId === lecture.id) {
      throw new Error('Stop the recording before renaming this lecture.')
    }
    // Renames the folder too, so the on-disk name keeps matching the title.
    return renameLecture(repos, requireClass(lecture.classId), lecture, title)
  })

  ipcMain.handle(IPC.lectureMove, async (_e, id: string, targetClassId: string): Promise<LectureRecord> => {
    const lecture = requireLecture(id)
    if (controller.currentLectureId === lecture.id) {
      throw new Error('Stop the recording before moving this lecture.')
    }
    return moveLecture(repos, lecture, requireClass(targetClassId))
  })

  ipcMain.handle(IPC.lectureDelete, async (_e, id: string, deleteFiles = false) => {
    const lecture = requireLecture(id)
    if (controller.currentLectureId === lecture.id) {
      throw new Error('Stop the recording before removing this lecture.')
    }
    return deleteLecture(repos, settings.get().rootDir, lecture, Boolean(deleteFiles))
  })

  ipcMain.handle(IPC.lectureSearch, (_e, query: string) => {
    const hits = repos.lectures.search(String(query ?? ''))
    return hits
      .map((hit) => {
        const lecture = repos.lectures.get(hit.lectureId)
        return lecture ? { lecture, snippet: hit.snippet } : null
      })
      .filter((x): x is { lecture: LectureRecord; snippet: string } => x !== null)
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

  // Audio frames use `send`, not `invoke`: they are high-frequency and
  // fire-and-forget, and a per-frame round trip would add needless latency.
  ipcMain.on(IPC.recordingAudio, (_e, chunk: ArrayBuffer) => {
    controller.writeAudio(chunk)
  })

  // --- transcript ----------------------------------------------------------

  const loadTranscript = async (lecture: LectureRecord): Promise<TranscriptFile | null> => {
    const paths = lecturePaths(lecture.dirPath)
    return (await readJson<TranscriptFile>(paths.transcript)) ?? readJson<TranscriptFile>(paths.liveTranscript)
  }

  ipcMain.handle(IPC.transcriptGet, async (_e, lectureId: string): Promise<TranscriptFile | null> =>
    loadTranscript(requireLecture(lectureId))
  )

  ipcMain.handle(IPC.transcriptRetry, async (_e, lectureId: string): Promise<void> => {
    const lecture = requireLecture(lectureId)
    const klass = requireClass(lecture.classId)
    if (controller.isRecording) throw new Error('Stop the current recording before retrying transcription.')
    void controller.transcribe(klass, lecture)
  })

  ipcMain.handle(
    IPC.transcriptSetSuggestion,
    async (_e, lectureId: string, suggestionId: string, status: SuggestionStatus): Promise<TranscriptFile> => {
      const lecture = requireLecture(lectureId)
      const paths = lecturePaths(lecture.dirPath)
      const transcript = await readJson<TranscriptFile>(paths.transcript)
      if (!transcript) throw new Error('No final transcript to edit yet.')

      const suggestion = transcript.suggestions.find((s) => s.id === suggestionId)
      if (!suggestion) throw new Error('That suggestion no longer exists.')
      suggestion.status = status
      transcript.updatedAt = new Date().toISOString()

      await writeJsonAtomic(paths.transcript, transcript)
      deps.broadcast(IPC.evtLibraryChanged, { lectureId })
      return transcript
    }
  )

  ipcMain.handle(IPC.transcriptAudioUrl, async (_e, lectureId: string): Promise<string | null> => {
    const lecture = requireLecture(lectureId)
    const paths = lecturePaths(lecture.dirPath)
    // Prefer the assembled file; fall back to the first segment so a lecture
    // that failed to transcribe is still listenable.
    const candidates = [paths.finalAudio]
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

  ipcMain.handle(
    IPC.exportMarkdown,
    async (_e, lectureId: string, options?: Partial<ExportOptions>): Promise<string> => {
      const { lecture, transcript } = await requireTranscript(lectureId)
      const merged = { ...DEFAULT_EXPORT_OPTIONS, ...options }
      const markdown = transcriptToMarkdown(transcript, merged)
      const target = lecturePaths(lecture.dirPath).markdown
      assertInRoot(target)
      await fs.writeFile(target, markdown, 'utf8')
      return target
    }
  )

  ipcMain.handle(IPC.exportPdf, async (_e, lectureId: string, options?: Partial<ExportOptions>): Promise<string> => {
    const { lecture, transcript } = await requireTranscript(lectureId)
    const merged = { ...DEFAULT_EXPORT_OPTIONS, ...options }
    const bytes = await transcriptToPdf(transcript, merged)
    const target = lecturePaths(lecture.dirPath).pdf
    assertInRoot(target)
    await fs.writeFile(target, bytes)
    return target
  })

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
