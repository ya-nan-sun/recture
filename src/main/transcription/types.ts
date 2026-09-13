import type { BatchProviderId, ProviderAvailability, TranscriptSegment } from '@shared/types'

export interface TranscriptionRequest {
  /** Absolute path to the assembled, verified WAV. */
  audioPath: string
  language: string
  /** Class glossary, passed as keyterm / vocabulary hints. */
  keyterms: string[]
  signal?: AbortSignal
  onProgress?: (progress: number | null, message: string) => void
}

export interface TranscriptionResult {
  provider: string
  model: string
  language: string
  durationSec: number
  segments: TranscriptSegment[]
}

export interface BatchTranscriber {
  readonly id: BatchProviderId
  readonly label: string
  /** True when audio leaves the device. Surfaced prominently in the UI. */
  readonly sendsAudioOffDevice: boolean
  checkAvailability(): Promise<ProviderAvailability>
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>
}

/** Thrown for conditions where retrying cannot help (bad key, bad audio). */
export class PermanentTranscriptionError extends Error {
  override readonly name: string = 'PermanentTranscriptionError'
}

/** Thrown for conditions worth retrying (network, 5xx, rate limit). */
export class TransientTranscriptionError extends Error {
  override readonly name = 'TransientTranscriptionError'
  constructor(
    message: string,
    readonly retryAfterMs?: number
  ) {
    super(message)
  }
}

/**
 * The job was stopped on purpose: the app is quitting or the lecture was
 * cancelled. Not a failure, so nothing is marked broken and nothing retries.
 */
export class TranscriptionAbortedError extends PermanentTranscriptionError {
  override readonly name: string = 'TranscriptionAbortedError'
}

/** None of the lecture's audio survived verification, so there is nothing to transcribe. */
export class NoUsableAudioError extends PermanentTranscriptionError {
  override readonly name: string = 'NoUsableAudioError'
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TranscriptionAbortedError('Transcription was stopped.')
}
