import {
  PermanentTranscriptionError,
  TransientTranscriptionError,
  TranscriptionAbortedError,
  throwIfAborted
} from './types'

export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  /** Injected in tests; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>
  /** Deterministic jitter in tests. */
  random?: () => number
  onRetry?: (attempt: number, delayMs: number, error: Error) => void
  /** Stops retrying, including in the middle of a backoff wait, once aborted. */
  signal?: AbortSignal
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 2000,
  maxDelayMs: 60_000
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Exponential backoff with full jitter, for the final transcription pass.
 *
 * A permanent error (bad key, malformed request, silent audio) aborts
 * immediately — retrying it just delays telling the student something is
 * wrong. Everything else is retried, because the raw audio is safe on disk and
 * a transient network failure should never cost a lecture.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = DEFAULT_RETRY
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  let lastError: Error = new Error('Operation never ran')

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    throwIfAborted(options.signal)
    try {
      return await operation(attempt)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      lastError = error

      // An abort surfaces from the operation as whatever it happened to throw:
      // a failed fetch, a killed process. Report it as the abort it is, so it
      // is neither retried nor mistaken for a failure.
      if (options.signal?.aborted) throw new TranscriptionAbortedError('Transcription was stopped.')
      if (error instanceof PermanentTranscriptionError) throw error
      if (attempt === options.maxAttempts) break

      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1))
      const suggested = error instanceof TransientTranscriptionError ? error.retryAfterMs : undefined
      // Full jitter avoids a thundering herd when several lectures are queued.
      const delay = suggested ?? Math.round(exponential * (0.5 + random() * 0.5))

      options.onRetry?.(attempt, delay, error)
      await abortableSleep(sleep, delay, options.signal)
    }
  }
  throw lastError
}

function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new TranscriptionAbortedError('Transcription was stopped.'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      reject
    )
  })
}
