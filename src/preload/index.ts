/**
 * The only bridge between the renderer and the main process.
 *
 * Context isolation is on and Node is off in the renderer, so this surface is
 * exhaustive: the renderer can do exactly what is listed here and nothing more.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  ClassRecord,
  ExportOptions,
  GlossaryTerm,
  HotkeyStatus,
  LectureRecord,
  LiveTranscriptUpdate,
  ProviderAvailability,
  RecordingState,
  SegmentVerification,
  SuggestionStatus,
  TranscriptFile,
  TranscriptionProgress
} from '@shared/types'

type Unsubscribe = () => void

export interface RescanReport {
  classesAdopted: number
  classesUpdated: number
  classesRemoved: number
  lecturesAdopted: number
  lecturesUpdated: number
  lecturesRemoved: number
  details: string[]
}

export interface DeleteOutcome {
  removedFromLibrary: true
  filesDeleted: boolean
  folder: string
}

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    providers: (): Promise<ProviderAvailability[]> => ipcRenderer.invoke(IPC.settingsProviders),
    setApiKey: (provider: 'deepgram', key: string | null): Promise<boolean> =>
      ipcRenderer.invoke(IPC.settingsSetApiKey, provider, key),
    hasApiKey: (provider: 'deepgram'): Promise<boolean> => ipcRenderer.invoke(IPC.settingsHasApiKey, provider),
    diskEncryption: (): Promise<{ encrypted: boolean | null; detail: string }> =>
      ipcRenderer.invoke(IPC.settingsDiskEncryption),
    chooseRoot: (): Promise<string | null> => ipcRenderer.invoke(IPC.settingsChooseRoot),
    hotkeyStatus: (): Promise<HotkeyStatus> => ipcRenderer.invoke(IPC.settingsHotkeyStatus),
    setHotkey: (accelerator: string): Promise<HotkeyStatus> =>
      ipcRenderer.invoke(IPC.settingsSetHotkey, accelerator)
  },

  library: {
    /** Reconcile the index with what is actually on disk. */
    rescan: (): Promise<RescanReport> => ipcRenderer.invoke(IPC.libraryRescan)
  },

  classes: {
    list: (): Promise<ClassRecord[]> => ipcRenderer.invoke(IPC.classesList),
    create: (input: { name: string; instructor?: string | null; color?: string | null }): Promise<ClassRecord> =>
      ipcRenderer.invoke(IPC.classCreate, input),
    update: (id: string, patch: { instructor?: string | null; color?: string | null }): Promise<ClassRecord> =>
      ipcRenderer.invoke(IPC.classUpdate, id, patch),
    rename: (id: string, name: string): Promise<ClassRecord> => ipcRenderer.invoke(IPC.classRename, id, name),
    /** `deleteFiles` erases the recordings from disk. Defaults to keeping them. */
    remove: (id: string, deleteFiles = false): Promise<DeleteOutcome & { lectureCount: number }> =>
      ipcRenderer.invoke(IPC.classDelete, id, deleteFiles)
  },

  lectures: {
    byClass: (classId: string): Promise<LectureRecord[]> => ipcRenderer.invoke(IPC.lecturesByClass, classId),
    all: (): Promise<LectureRecord[]> => ipcRenderer.invoke(IPC.lecturesAll),
    get: (id: string): Promise<LectureRecord> => ipcRenderer.invoke(IPC.lectureGet, id),
    create: (classId: string, input: { title?: string }): Promise<LectureRecord> =>
      ipcRenderer.invoke(IPC.lectureCreate, classId, input),
    rename: (id: string, title: string): Promise<LectureRecord> => ipcRenderer.invoke(IPC.lectureRename, id, title),
    move: (id: string, targetClassId: string): Promise<LectureRecord> =>
      ipcRenderer.invoke(IPC.lectureMove, id, targetClassId),
    /** `deleteFiles` erases the audio from disk. Defaults to keeping it. */
    remove: (id: string, deleteFiles = false): Promise<DeleteOutcome> =>
      ipcRenderer.invoke(IPC.lectureDelete, id, deleteFiles),
    search: (query: string): Promise<{ lecture: LectureRecord; snippet: string }[]> =>
      ipcRenderer.invoke(IPC.lectureSearch, query),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke(IPC.lectureReveal, id),
    verify: (
      id: string
    ): Promise<{
      verified: { relPath: string; absPath: string }[]
      corrupt: { relPath: string; reason: SegmentVerification; detail: string }[]
    }> => ipcRenderer.invoke(IPC.lectureVerify, id)
  },

  glossary: {
    list: (classId: string): Promise<GlossaryTerm[]> => ipcRenderer.invoke(IPC.glossaryList, classId),
    add: (classId: string, term: string, note: string | null): Promise<GlossaryTerm> =>
      ipcRenderer.invoke(IPC.glossaryAdd, classId, term, note),
    update: (classId: string, id: string, patch: { term?: string; note?: string | null }): Promise<GlossaryTerm[]> =>
      ipcRenderer.invoke(IPC.glossaryUpdate, classId, id, patch),
    remove: (classId: string, id: string): Promise<GlossaryTerm[]> =>
      ipcRenderer.invoke(IPC.glossaryRemove, classId, id),
    importText: (classId: string, text: string): Promise<GlossaryTerm[]> =>
      ipcRenderer.invoke(IPC.glossaryImport, classId, text)
  },

  recording: {
    start: (classId: string, lectureId: string | null): Promise<RecordingState> =>
      ipcRenderer.invoke(IPC.recordingStart, classId, lectureId),
    stop: (): Promise<{ lectureId: string }> => ipcRenderer.invoke(IPC.recordingStop),
    state: (): Promise<RecordingState> => ipcRenderer.invoke(IPC.recordingState),
    /** Fire-and-forget PCM frame. The ArrayBuffer is transferred, not copied. */
    sendAudio: (chunk: ArrayBuffer): void => ipcRenderer.send(IPC.recordingAudio, chunk)
  },

  transcript: {
    get: (lectureId: string): Promise<TranscriptFile | null> => ipcRenderer.invoke(IPC.transcriptGet, lectureId),
    retry: (lectureId: string): Promise<void> => ipcRenderer.invoke(IPC.transcriptRetry, lectureId),
    setSuggestion: (lectureId: string, suggestionId: string, status: SuggestionStatus): Promise<TranscriptFile> =>
      ipcRenderer.invoke(IPC.transcriptSetSuggestion, lectureId, suggestionId, status),
    audioUrl: (lectureId: string): Promise<string | null> => ipcRenderer.invoke(IPC.transcriptAudioUrl, lectureId)
  },

  exports: {
    markdown: (lectureId: string, options?: Partial<ExportOptions>): Promise<string> =>
      ipcRenderer.invoke(IPC.exportMarkdown, lectureId, options),
    pdf: (lectureId: string, options?: Partial<ExportOptions>): Promise<string> =>
      ipcRenderer.invoke(IPC.exportPdf, lectureId, options),
    clipboard: (
      lectureId: string,
      options?: Partial<ExportOptions>
    ): Promise<{ copied: boolean; length: number; sections?: { label: string; text: string }[] }> =>
      ipcRenderer.invoke(IPC.exportClipboard, lectureId, options),
    copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:write', text)
  },

  events: {
    onRecordingState: (handler: (state: RecordingState) => void): Unsubscribe =>
      on<RecordingState>(IPC.evtRecordingState, handler),
    onRecordingError: (handler: (payload: { lectureId: string; message: string }) => void): Unsubscribe =>
      on(IPC.evtRecordingError, handler),
    onLiveTranscript: (handler: (update: LiveTranscriptUpdate) => void): Unsubscribe =>
      on<LiveTranscriptUpdate>(IPC.evtLiveTranscript, handler),
    onTranscriptionProgress: (handler: (progress: TranscriptionProgress) => void): Unsubscribe =>
      on<TranscriptionProgress>(IPC.evtTranscriptionProgress, handler),
    onLibraryChanged: (handler: (payload: unknown) => void): Unsubscribe => on(IPC.evtLibraryChanged, handler),
    onToggleRecord: (handler: () => void): Unsubscribe => on(IPC.evtRequestToggleRecord, () => handler())
  }
}

export type RectureApi = typeof api

contextBridge.exposeInMainWorld('recture', api)
