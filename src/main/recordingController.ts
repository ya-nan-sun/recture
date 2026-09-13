/**
 * Owns the lifecycle of a recording: one RecordingSession writing audio to
 * disk, and an optional Deepgram live socket for the on-screen draft.
 *
 * Transcription is deliberately not part of the recording lifecycle. Stopping
 * hands the lecture to the transcription queue and returns at once, so the
 * student can start their next lecture immediately instead of waiting for the
 * previous one to finish transcribing.
 *
 * The live socket is strictly best-effort. Nothing it does can affect what
 * lands on disk.
 */

import type { BrowserWindow } from 'electron'
import type {
  AppSettings,
  Bookmark,
  ClassRecord,
  LectureRecord,
  LiveStatus,
  LiveTranscriptUpdate,
  RecordingState,
  TranscriptFile,
  TranscriptionProgress
} from '@shared/types'
import { IPC } from '@shared/ipc'
import { glossaryKeyterms } from '@shared/correction'
import { lecturePaths, readJson, writeJsonAtomic } from './storage/paths'
import { RecordingSession } from './audio/recordingSession'
import type { Repos } from './db/repos'
import { DeepgramLiveSession } from './transcription/deepgramLive'
import type { BatchTranscriber } from './transcription/types'
import { handleFinalPassFailure, runFinalPass } from './transcription/pipeline'
import {
  TranscriptionQueue,
  type AbortReason,
  type QueueSnapshot,
  type TranscriptionJob,
  type TranscriptionJobReason
} from './transcription/queue'
import { addBookmark } from './bookmarks'
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
  private pausedAt: Date | null = null
  private pausedMs = 0
  private sessionBookmarks: Bookmark[] = []
  readonly queue: TranscriptionQueue

  constructor(private readonly deps: ControllerDeps) {
    this.queue = new TranscriptionQueue({
      run: (job, signal) => this.runJob(job, signal),
      onChange: (snapshot) => this.deps.broadcast(IPC.evtTranscriptionQueue, snapshot)
    })
  }

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
      live: this.liveStatus,
      paused: this.session?.isPaused ?? false,
      pausedMs: this.pausedMs,
      pausedAt: this.pausedAt?.toISOString() ?? null,
      offsetSec: this.session?.offsetSec ?? 0,
      bookmarks: [...this.sessionBookmarks]
    }
  }

  queueSnapshot(): QueueSnapshot {
    return this.queue.snapshot()
  }

  private emitState(): void {
    this.deps.broadcast(IPC.evtRecordingState, this.getState())
  }

  async start(klass: ClassRecord, lecture: LectureRecord): Promise<RecordingState> {
    if (this.isRecording) throw new Error('A recording is already in progress.')
    // Adding audio to a lecture that is queued or mid-pass would transcribe a
    // moving target.
    if (this.queue.has(lecture.id)) {
      throw new Error(
        'That lecture is waiting to be transcribed. Record into a new lecture, or cancel its transcription first.'
      )
    }

    const settings = this.deps.getSettings()
    const session: RecordingSession = new RecordingSession({
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
          segmentCount: session.segmentCount,
          durationSec: session.durationSec
        })
        this.emitState()
      },
      onError: (error) => {
        // A write failure is the one thing the student must know about now,
        // while they can still switch devices or free up disk space.
        this.deps.repos.lectures.setStatus(lecture.id, 'needs_attention', `Audio write failed: ${error.message}`)
        this.deps.broadcast(IPC.evtRecordingError, { lectureId: lecture.id, message: error.message })
        this.emitState()
      }
    })

    // Only adopt the session once it has opened its files, so a failed start
    // leaves no half-initialised recording behind.
    await session.start()

    this.session = session
    this.activeClass = klass
    this.activeLecture = lecture
    this.startedAt = new Date()
    this.pausedAt = null
    this.pausedMs = 0
    this.sessionBookmarks = []
    this.liveCursor = 0
    this.liveFinals = []

    this.deps.repos.lectures.setStatus(lecture.id, 'recording', null)
    this.startLive(klass, settings, session.offsetSec)
    this.emitState()
    return this.getState()
  }

  /** Pause for a break without ending the lecture. */
  async pause(): Promise<RecordingState> {
    const session = this.session
    if (!session || !this.isRecording) throw new Error('No recording is in progress.')
    if (!session.isPaused) {
      this.pausedAt = new Date()
      await session.pause()
      this.emitState()
    }
    return this.getState()
  }

  resume(): RecordingState {
    const session = this.session
    if (!session || !this.isRecording) throw new Error('No recording is in progress.')
    if (session.isPaused) {
      session.resume()
      if (this.pausedAt) this.pausedMs += Math.max(0, Date.now() - this.pausedAt.getTime())
      this.pausedAt = null
      this.emitState()
    }
    return this.getState()
  }

  /** Flag the current moment of the lecture, e.g. "this is on the exam". */
  async addBookmark(note = ''): Promise<Bookmark> {
    const session = this.session
    const lecture = this.activeLecture
    if (!session || !lecture || !this.isRecording) {
      throw new Error('Bookmarks can only be added while recording.')
    }
    const bookmark = await addBookmark(lecture.dirPath, session.durationSec, note)
    this.sessionBookmarks.push(bookmark)
    this.deps.broadcast(IPC.evtBookmarkAdded, { lectureId: lecture.id, bookmark })
    this.emitState()
    return bookmark
  }

  private startLive(klass: ClassRecord, settings: AppSettings, offsetSec: number): void {
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
          // Deepgram times from the start of this stream. When recording into a
          // lecture that already had audio, its clock starts where that ended.
          start: result.start + offsetSec,
          end: result.end + offsetSec,
          text: result.text,
          isFinal: result.isFinal
        }
        if (result.isFinal) {
          this.liveFinals.push(update)
          this.liveCursor += 1
        }
        this.deps.broadcast(IPC.evtLiveTranscript, update)
      }
    })
    this.live.connect()
  }

  /** One PCM frame from the renderer. Discarded while paused. */
  writeAudio(chunk: ArrayBuffer): void {
    const session = this.session
    if (!session || session.isStopped || session.isPaused) return
    const buffer = Buffer.from(chunk)
    session.write(buffer)
    this.live?.send(buffer)
  }

  /**
   * Stop recording and queue the final pass. Resolves once the audio is safely
   * closed out; transcription continues independently and reports through
   * `transcription:progress` and `transcription:queue`.
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
      status: 'queued',
      statusDetail: null
    })
    await this.saveLiveDraft(klass, lecture, durationSec, session.offsetSec)

    // The recording is over. Clear it now, not after transcription, so the
    // next lecture can start straight away.
    this.clearRecordingState()
    this.emitState()

    this.queue.enqueue({ lectureId: lecture.id, reason: 'recorded' })
    return { lectureId: lecture.id }
  }

  private clearRecordingState(): void {
    this.session = null
    this.activeClass = null
    this.activeLecture = null
    this.startedAt = null
    this.pausedAt = null
    this.pausedMs = 0
    this.sessionBookmarks = []
  }

  /** Persist the live draft as a fallback before the final pass replaces it. */
  private async saveLiveDraft(
    klass: ClassRecord,
    lecture: LectureRecord,
    durationSec: number,
    offsetSec: number
  ): Promise<void> {
    if (this.liveFinals.length === 0) return
    const paths = lecturePaths(lecture.dirPath)
    // When recording into a lecture that already had audio, keep the draft of
    // that earlier audio rather than replacing it with only this session's.
    const previous = offsetSec > 0 ? await readJson<TranscriptFile>(paths.liveTranscript) : null
    const earlier = (previous?.segments ?? []).filter((s) => s.end <= offsetSec + 0.001)
    const now = new Date().toISOString()
    const stamp = Date.parse(now)

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
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      segments: [
        ...earlier,
        ...this.liveFinals.map((u, i) => ({
          id: `live-${stamp}-${i}`,
          start: u.start,
          end: u.end,
          speaker: null,
          text: u.text,
          words: u.text
            .split(' ')
            .filter(Boolean)
            .map((word, k, arr) => {
              const span = (u.end - u.start) / Math.max(1, arr.length)
              return { word, start: u.start + k * span, end: u.start + (k + 1) * span, confidence: 1 }
            })
        }))
      ],
      suggestions: [],
      excludedAudioSegments: []
    }
    await writeJsonAtomic(paths.liveTranscript, draft).catch(() => undefined)
  }

  /**
   * Put a lecture in the transcription queue. Safe to call for a lecture that
   * is already queued or running: it is never transcribed (or billed) twice.
   */
  requestTranscription(
    lectureId: string,
    reason: TranscriptionJobReason = 'retry'
  ): { accepted: boolean; position: number } {
    if (this.activeLecture?.id === lectureId) {
      throw new Error('Stop recording this lecture before transcribing it.')
    }
    const lecture = this.deps.repos.lectures.get(lectureId)
    if (!lecture) throw new Error('That lecture no longer exists.')
    if (this.queue.has(lectureId)) {
      return { accepted: false, position: this.queue.position(lectureId) }
    }

    // A resumed job keeps the note explaining why it restarted.
    this.deps.repos.lectures.setStatus(lectureId, 'queued', reason === 'resumed' ? lecture.statusDetail : null)
    const result = this.queue.enqueue({ lectureId, reason })
    this.deps.broadcast(IPC.evtLibraryChanged, { lectureId })
    return result
  }

  /**
   * Take a lecture out of the queue, stopping it if it is mid-pass. Resolves
   * once a running transcriber has let go of the lecture's files.
   */
  async cancelTranscription(lectureId: string): Promise<boolean> {
    const wasWaiting = this.queue.has(lectureId) && !this.queue.isRunning(lectureId)
    const cancelled = await this.queue.cancel(lectureId)
    if (cancelled && wasWaiting) {
      this.deps.repos.lectures.setStatus(lectureId, 'needs_transcription', 'Transcription was cancelled.')
      this.deps.broadcast(IPC.evtLibraryChanged, { lectureId })
    }
    // A running job records its own status when it sees the cancellation.
    return cancelled
  }

  private async runJob(job: TranscriptionJob, signal: AbortSignal): Promise<void> {
    const { repos } = this.deps
    const onProgress = (progress: TranscriptionProgress): void =>
      this.deps.broadcast(IPC.evtTranscriptionProgress, progress)

    // Read the lecture fresh: it may have been renamed or moved while it waited.
    const lecture = repos.lectures.get(job.lectureId)
    const klass = lecture ? repos.classes.get(lecture.classId) : null
    if (!lecture || !klass) return

    try {
      await syncGlossaryToDisk(repos, klass).catch(() => undefined)
      await runFinalPass(klass, lecture, {
        repos,
        settings: this.deps.getSettings(),
        transcriber: this.deps.getTranscriber(),
        glossary: repos.glossary.listByClass(klass.id),
        onProgress,
        signal
      })
    } catch (err) {
      if (signal.aborted) {
        if ((signal.reason as AbortReason) === 'shutdown') {
          // Picked up again on the next launch.
          repos.lectures.setStatus(
            lecture.id,
            'queued',
            'Transcription was interrupted when Recture closed. It will restart next time.'
          )
        } else {
          repos.lectures.setStatus(lecture.id, 'needs_transcription', 'Transcription was cancelled.')
        }
        onProgress({ lectureId: lecture.id, phase: 'failed', message: 'Transcription was stopped.', progress: null })
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      await handleFinalPassFailure(repos, lecture, error, onProgress)
    } finally {
      this.deps.broadcast(IPC.evtLibraryChanged, { lectureId: lecture.id })
    }
  }

  /**
   * Close everything down on app quit: finish writing the current segment,
   * and stop any transcription so Python is never left running in the
   * background. An interrupted lecture keeps its place and resumes next launch.
   */
  async shutdown(): Promise<void> {
    if (this.session) {
      await this.session.stop().catch(() => undefined)
    }
    await this.live?.close().catch(() => undefined)
    this.live = null
    await this.queue.shutdown()
    this.clearRecordingState()
  }
}

export function broadcaster(getWindows: () => BrowserWindow[]) {
  return (channel: string, payload: unknown): void => {
    for (const win of getWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
}
