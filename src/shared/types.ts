/**
 * Types shared between main, preload and renderer.
 *
 * Everything crossing the IPC boundary is structured-cloneable: plain objects,
 * arrays, primitives and ArrayBuffers only.
 */

// ---------------------------------------------------------------------------
// Audio format
// ---------------------------------------------------------------------------

/**
 * The one audio format this app records in. 16 kHz mono 16-bit PCM is enough
 * for every STT model we target and keeps ~10 hrs/week of lectures at a
 * manageable ~115 MB/hr.
 */
export const AUDIO_FORMAT = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16
} as const

/** Default rolling segment length. Bounded data loss on crash. */
export const DEFAULT_SEGMENT_SECONDS = 45

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface ClassRecord {
  id: string
  name: string
  /** Absolute path to `Classes/<Class Name>`. */
  dirPath: string
  instructor: string | null
  color: string | null
  createdAt: string
  updatedAt: string
}

export type LectureStatus =
  | 'recording'
  /** Waiting its turn in the transcription queue. */
  | 'queued'
  | 'assembling'
  | 'transcribing'
  | 'complete'
  /** Final pass failed after retries. Audio is intact and verified. */
  | 'needs_transcription'
  /** One or more segments failed checksum verification. */
  | 'needs_attention'

export interface LectureRecord {
  id: string
  classId: string
  title: string
  /** Absolute path to `Classes/<Class>/<Lecture Date - Title>`. */
  dirPath: string
  /** ISO date the lecture was recorded (local calendar date + time). */
  recordedAt: string
  durationSec: number
  status: LectureStatus
  /** Human-readable reason accompanying a failed / needs-attention status. */
  statusDetail: string | null
  /** Provider+model that produced the transcript currently on disk. */
  transcriptSource: string | null
  /** Whether the transcript on disk came from the final pass or the live draft. */
  transcriptPass: TranscriptPass | null
  segmentCount: number
  corruptSegmentCount: number
  createdAt: string
  updatedAt: string
}

export interface GlossaryTerm {
  id: string
  classId: string
  term: string
  /** Optional note shown in the review panel, e.g. "professor's name". */
  note: string | null
  createdAt: string
}

export interface SegmentRecord {
  id: string
  lectureId: string
  index: number
  /** Path relative to the lecture directory, e.g. `audio/segment-0001.wav`. */
  relPath: string
  startSec: number
  durationSec: number
  byteLength: number
  sha256: string
  /** Result of the most recent verification pass. */
  verified: SegmentVerification
  createdAt: string
}

export type SegmentVerification = 'pending' | 'ok' | 'checksum_mismatch' | 'missing' | 'unreadable'

/**
 * A moment the student flagged while recording ("this is on the exam").
 * Stored in the lecture folder as bookmarks.json.
 */
export interface Bookmark {
  id: string
  /** Position in the lecture's audio, in seconds. */
  atSec: number
  note: string
  createdAt: string
}

/** What the transcription queue is doing right now. */
export interface TranscriptionQueueSnapshot {
  running: { lectureId: string; startedAt: string } | null
  /** Lecture ids waiting their turn, in order. */
  waiting: string[]
}

// ---------------------------------------------------------------------------
// transcript.json — the single source of truth for every export
// ---------------------------------------------------------------------------

export type TranscriptPass = 'final' | 'live-draft'

export interface TranscriptWord {
  word: string
  start: number
  end: number
  /** 0..1, provider-reported. */
  confidence: number
}

export interface TranscriptSegment {
  id: string
  start: number
  end: number
  /** Speaker label when the provider supplies diarization, else null. */
  speaker: string | null
  text: string
  words: TranscriptWord[]
}

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected'

/**
 * A *suggested* correction against a known glossary term. Never auto-applied:
 * the student accepts or rejects each one. The correction step may only ever
 * propose replacing a span with a term that already exists in the class
 * glossary — it can never invent a replacement.
 */
export interface CorrectionSuggestion {
  id: string
  segmentId: string
  /** Index of the first word of the matched span within the segment. */
  wordIndex: number
  /** Number of words the span covers (1..3). */
  wordCount: number
  start: number
  end: number
  /** Exactly the text as transcribed. */
  original: string
  /** The glossary term proposed in its place. */
  suggested: string
  /** Lowest word confidence across the span. */
  spanConfidence: number
  /** 0..1 string/phonetic similarity that triggered the suggestion. */
  similarity: number
  reason: string
  status: SuggestionStatus
}

export interface TranscriptFile {
  version: 1
  lectureId: string
  classId: string
  className: string
  lectureTitle: string
  recordedAt: string
  durationSec: number
  source: {
    pass: TranscriptPass
    provider: string
    model: string
    language: string
  }
  createdAt: string
  updatedAt: string
  segments: TranscriptSegment[]
  suggestions: CorrectionSuggestion[]
  /** Audio segments that failed verification and were excluded, if any. */
  excludedAudioSegments: { relPath: string; reason: SegmentVerification }[]
}

// ---------------------------------------------------------------------------
// Transcription providers
// ---------------------------------------------------------------------------

export type BatchProviderId = 'whisper-local' | 'deepgram-batch'
export type LiveProviderId = 'deepgram-live' | 'none'

export interface ProviderAvailability {
  id: BatchProviderId | LiveProviderId
  available: boolean
  /** Why it is unavailable, shown in settings. */
  detail: string
  /** True when using it sends audio off the device. */
  sendsAudioOffDevice: boolean
}

/** Whether the global record shortcut is actually registered with the OS. */
export interface HotkeyStatus {
  accelerator: string
  registered: boolean
  detail: string
}

export interface AppSettings {
  /** Root folder containing `Classes/`. */
  rootDir: string
  segmentSeconds: number
  liveProvider: LiveProviderId
  batchProvider: BatchProviderId
  deepgramLiveModel: string
  deepgramBatchModel: string
  whisperModel: string
  /** Whisper compute type, e.g. `int8`, `float16`. */
  whisperComputeType: string
  language: string
  /** Global hotkey accelerator for record start/stop. */
  recordHotkey: string
  /** Global hotkey accelerator that bookmarks the current moment while recording. */
  bookmarkHotkey: string
  /** Minimum word confidence below which a span is considered for correction. */
  correctionConfidenceThreshold: number
  /** Minimum similarity to a glossary term required to raise a suggestion. */
  correctionSimilarityThreshold: number
  /** User has seen and acknowledged the cloud-audio disclosure. */
  acknowledgedCloudNotice: boolean
  /** Microphone chosen in Mic check, used for recording. Empty for the system default. */
  micDeviceId: string
  /**
   * A saved API key could not be carried over from LectureRec and must be
   * pasted again. Cleared once a key is saved.
   */
  apiKeyReentryNotice: boolean
}

/** Space on the drive that holds the library. */
export interface DiskSpace {
  freeBytes: number
  totalBytes: number
}

/** Sent when the computer wakes from sleep during a recording. */
export interface PowerNotice {
  kind: 'resumed-after-sleep'
  /** True when the recording was paused because of the sleep. */
  pausedForSleep: boolean
}

// ---------------------------------------------------------------------------
// Live recording events (main -> renderer)
// ---------------------------------------------------------------------------

export interface RecordingState {
  active: boolean
  lectureId: string | null
  lectureTitle: string | null
  className: string | null
  startedAt: string | null
  elapsedSec: number
  segmentsWritten: number
  bytesWritten: number
  /** Live transcription link status. */
  live: LiveStatus
  /** True while paused mid-lecture; incoming audio is discarded. */
  paused: boolean
  /** Milliseconds spent in pauses that have already ended. */
  pausedMs: number
  /** When the current pause began, or null when not paused. */
  pausedAt: string | null
  /** Seconds of audio the lecture already had when this session began. */
  offsetSec: number
  /** Bookmarks added during this session. */
  bookmarks: Bookmark[]
}

export type LiveStatus =
  | { kind: 'disabled' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'error'; message: string }

export interface LiveTranscriptUpdate {
  lectureId: string
  /** Monotonic id so the renderer can replace an interim result in place. */
  cursor: number
  start: number
  end: number
  text: string
  isFinal: boolean
}

export interface TranscriptionProgress {
  lectureId: string
  phase: 'verifying' | 'assembling' | 'transcribing' | 'correcting' | 'writing' | 'done' | 'failed'
  message: string
  /** 0..1 when known. */
  progress: number | null
  attempt?: number
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportOptions {
  includeTimestamps: boolean
  /** Apply accepted suggestions to the exported text. */
  applyAcceptedSuggestions: boolean
  /** Group consecutive segments into paragraphs of roughly this many seconds. */
  paragraphSeconds: number
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeTimestamps: true,
  applyAcceptedSuggestions: true,
  paragraphSeconds: 30
}

/** Above this many characters the UI offers per-section copy instead. */
export const CLIPBOARD_SOFT_LIMIT = 100_000
