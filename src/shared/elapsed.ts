/**
 * The number on the recording clock.
 *
 * Derived from the recording state rather than from segment broadcasts, which
 * only arrive every ~45 seconds and would leave the clock visibly frozen.
 */

import type { RecordingState } from './types'

export type ElapsedInput = Pick<
  RecordingState,
  'active' | 'startedAt' | 'paused' | 'pausedMs' | 'pausedAt' | 'offsetSec'
>

/**
 * Seconds of lecture so far: wall-clock time since this session started, minus
 * time spent paused, plus any audio the lecture already had when recording
 * resumed into it.
 */
export function computeElapsedSec(state: ElapsedInput | null | undefined, nowMs: number): number {
  if (!state || !state.active || !state.startedAt) return 0
  const offset = Number.isFinite(state.offsetSec) ? state.offsetSec : 0
  const started = Date.parse(state.startedAt)
  if (Number.isNaN(started)) return offset

  let pausedMs = Number.isFinite(state.pausedMs) ? state.pausedMs : 0
  if (state.paused && state.pausedAt) {
    const pausedAt = Date.parse(state.pausedAt)
    if (!Number.isNaN(pausedAt)) pausedMs += Math.max(0, nowMs - pausedAt)
  }
  return offset + Math.max(0, nowMs - started - pausedMs) / 1000
}
