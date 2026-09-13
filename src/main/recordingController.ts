/**
 * Owns the lifecycle of a recording: one RecordingSession writing audio to
 * disk, an optional Deepgram live socket for the on-screen draft, and the
 * final pass that runs the moment recording stops.
 *
 * The live socket is strictly best-effort. Nothing it does can affect what
 * lands on disk.
 */

import type { BrowserWindow } from 'electron'
import type {
  AppSettings,
  ClassRecord,
  LectureRecord,
  LiveStatus,
  LiveTranscriptUpdate,
  RecordingState,
  TranscriptFile,
  TranscriptionProgress
} from '@shared/types'
import { glossaryKeyterms } from '@shared/correction'
import { lecturePaths, writeJsonAtomic } from './storage/paths'
import { RecordingSession } from './audio/recordingSession'
import type { Repos } from './db/repos'
import { DeepgramLiveSession } from './transcription/deepgramLive'
import type { BatchTranscriber } from './transcription/types'
import { handleFinalPassFailure, runFinalPass } from './transcription/pipeline'
import { syncGlossaryToDisk } from './library'

export interface ControllerDeps {
  repos: Repos
  getSettings: () => AppSettings
  getApiKey: (provider: 'deepgram') => string | null
  getTranscriber: () => BatchTranscriber
  broadcast: (channel: string, payload: unknown) => void
}

export class RecordingController {
  private session: RecordingSession | null = null
  private live: DeepgramLiveSession | null = null
  private liveStatus: LiveStatus = { kind: 'disabled' }
  private liveCursor = 0
  private liveFinals: LiveTranscriptUpdate[] = []
  private activeClass: ClassRecord | null = null
  private activeLecture: LectureRecord | null = null
  private startedAt: Date | null = null
  private finalizing = false

  constructor(private readonly deps: ControllerDeps) {}

  get isRecording(): boolean {
    return this.session !== null && !this.session.isStopped
  }

  get currentLectureId(): string | null {
    return this.activeLecture?.id ?? null
  }

  getState(): RecordingState {
    return {
      active: this.isRecording,
      lectureId: this.activeLecture?.id ?? null,
      lectureTitle: this.activeLecture?.title ?? null,
      className: this.activeClass?.name ?? null,
      startedAt: this.startedAt?.toISOString() ?? null,
      elapsedSec: this.session?.durationSec ?? 0,
      segmentsWritten: this.session?.segmentCount ?? 0,
      bytesWritten: this.session?.totalBytes ?? 0,
      live: this.liveStatus
    }
  }

  private emitState(): void {
    this.deps.broadcast('recording:state', this.getState())
  }

  async start(klass: ClassRecord, lecture: LectureRecord): Promise<RecordingState> {
    if (this.isRecording) throw new Error('A recording is already in progress.')
    if (this.finalizing) throw new Error('The previous lecture is still being finalized.')

    const settings = this.deps.getSettings()
    this.activeClass = klass
    this.activeLecture = lecture
    this.startedAt = new Date()
    this.liveCursor = 0
    this.liveFinals = []

    this.session = new RecordingSession({
      lectureId: lecture.id,
      lectureDir: lecture.dirPath,
      segmentSeconds: settings.segmentSeconds,
      onSegmentComplete: (entry) => {
        this.deps.repos.segments.add({
          lectureId: lecture.id,
          index: entry.index,
          relPath: entry.relPath,
          startSec: entry.startSec,
          durationSec: entry.durationSec,
          byteLength: entry.byteLength,
          sha256: entry.sha256,
          verified: 'pending'
        })
        this.deps.repos.lectures.update(lecture.id, {
          segmentCount: this.session?.segmentCount ?? 0,
          durationSec: this.session?.durationSec ?? 0
        })
        this.emitState()
      },
      onError: (error) => {
        // A write failure is the one thing the student must know about now,
        // while they can still switch devices or free up disk space.
        this.deps.repos.lectures.setStatus(lecture.id, 'needs_attention', `Audio write failed: ${error.message}`)
        this.deps.broadcast('recording:error', { lectureId: lecture.id, message: error.message })
        this.emitState()
      }
    })

    await this.session.start()
    this.deps.repos.lectures.setStatus(lecture.id, 'recording', null)

    this.startLive(klass, settings)
    this.emitState()
    return this.getState()
  }

  private startLive(klass: ClassRecord, settings: AppSettings): void {
    if (settings.liveProvider !== 'deepgram-live') {
      this.liveStatus = { kind: 'disabled' }
      return
    }
    const apiKey = this.deps.getApiKey('deepgram')
    if (!apiKey) {
      this.liveStatus = { kind: 'error', message: 'No Deepgram API key — live draft is off. Recording is unaffected.' }
      return
    }

    const glossary = this.deps.repos.glossary.listByClass(klass.id)
    this.live = new DeepgramLiveSession({
      apiKey,
      model: settings.deepgramLiveModel,
      language: settings.language,
      keyterms: glossaryKeyterms(glossary),
      onStatus: (status) => {
        this.liveStatus = status
        this.emitState()
      },
      onResult: (result) => {
        const lectureId = this.activeLecture?.id
        if (!lectureId) return
        const update: LiveTranscriptUpdate = {
          lectureId,
          // Interim results share the previous cursor so the renderer replaces
          // them in place; a final result advances it.
          cursor: this.liveCursor,
          start: result.start,
          end: result.end,
          text: result.text,
          isFinal: result.isFinal
        }
        if (result.isFinal) {
          this.liveFinals.push(update)
          this.liveCursor += 1
        }
        this.deps.broadcast('recording:live-transcript', update)
      }
    })
    this.live.connect()
  }

  /** One PCM frame from the renderer. */
  writeAudio(chunk: ArrayBuffer): void {
    if (!this.session || this.session.isStopped) return
    const buffer = Buffer.from(chunk)
    this.session.write(buffer)
    this.live?.send(buffer)
  }

  /**
   * Stop recording and kick off the final pass. Resolves once the audio is
   * safely closed out — the final pass continues in the background and reports
   * through `transcription:progress`.
   */
  async stop(): Promise<{ lectureId: string }> {
    const session = this.session
    const lecture = this.activeLecture
    const klass = this.activeClass
    if (!session || !lecture || !klass) throw new Error('No recording is in progress.')

    await session.stop()
    await this.live?.close().catch(() => undefined)
    this.live = null
    this.liveStatus = { kind: 'disabled' }

    const durationSec = session.durationSec
    this.deps.repos.lectures.update(lecture.id, {
      durationSec,
      segmentCount: session.segmentCount,
      status: 'transcribing'
    })

    await this.saveLiveDraft(klass, lecture, durationSec)

    this.session = null
    this.emitState()

    // Deliberately not awaited: the UI returns to the lecture view while the
    // final pass runs.
    void this.runFinalPassInBackground(klass, lecture)
    return { lectureId: lecture.id }
  }

  /** Persist the live draft as a fallback before the final pass replaces it. */
  private async saveLiveDraft(klass: ClassRecord, lecture: LectureRecord, durationSec: number): Promise<void> {
    if (this.liveFinals.length === 0) return
    const now = new Date().toISOString()
    const draft: TranscriptFile = {
      version: 1,
      lectureId: lecture.id,
      classId: klass.id,
      className: klass.name,
      lectureTitle: lecture.title,
      recordedAt: lecture.recordedAt,
      durationSec,
      source: {
        pass: 'live-draft',
        provider: 'deepgram-live',
        model: this.deps.getSettings().deepgramLiveModel,
        language: this.deps.getSettings().language
      },
      createdAt: now,
      updatedAt: now,
      segments: this.liveFinals.map((u, i) => ({
        id: `live-${i}`,
        start: u.start,
        end: u.end,
        speaker: null,
        text: u.text,
        words: u.text.split(/\s+/).map((word, k, arr) => {
          const span = (u.end - u.start) / Math.max(1, arr.length)
          return { word, start: u.start + k * span, end: u.start + (k + 1) * span, confidence: 1 }
        })
      })),
      suggestions: [],
      excludedAudioSegments: []
    }
    await writeJsonAtomic(lecturePaths(lecture.dirPath).liveTranscript, draft).catch(() => undefined)
  }

  private async runFinalPassInBackground(klass: ClassRecord, lecture: LectureRecord): Promise<void> {
    this.finalizing = true
    try {
      await this.transcribe(klass, lecture)
    } finally {
      this.finalizing = false
      this.activeClass = null
      this.activeLecture = null
      this.startedAt = null
      this.emitState()
    }
  }

  /** Run (or re-run) the final pass for a lecture. */
  async transcribe(klass: ClassRecord, lecture: LectureRecord): Promise<void> {
    const onProgress = (progress: TranscriptionProgress): void =>
      this.deps.broadcast('transcription:progress', progress)

    try {
      await syncGlossaryToDisk(this.deps.repos, klass).catch(() => undefined)
      await runFinalPass(klass, lecture, {
        repos: this.deps.repos,
        settings: this.deps.getSettings(),
        transcriber: this.deps.getTranscriber(),
        glossary: this.deps.repos.glossary.listByClass(klass.id),
        onProgress
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      await handleFinalPassFailure(this.deps.repos, lecture, error, onProgress)
    } finally {
      this.deps.broadcast('library:changed', { lectureId: lecture.id })
    }
  }

  /** Close everything down on app quit without losing the current segment. */
  async shutdown(): Promise<void> {
    if (this.session) {
      await this.session.stop().catch(() => undefined)
      this.session = null
    }
    await this.live?.close().catch(() => undefined)
    this.live = null
  }
}

export function broadcaster(getWindows: () => BrowserWindow[]) {
  return (channel: string, payload: unknown): void => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
}
