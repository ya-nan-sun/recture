/**
 * Notices when the microphone has gone quiet for too long during a recording.
 *
 * Finding out after a 90-minute lecture that the laptop recorded silence — a
 * muted mic, the wrong input, a headset that disconnected — is the worst
 * failure this app can have, and the only fix is to catch it while the lecture
 * is still happening.
 */

export interface SilenceOptions {
  /** RMS amplitude below which a reading counts as silence (about -50 dBFS). */
  threshold: number
  /** How long silence must last before warning. Long enough for a pause to think. */
  warnAfterMs: number
  /** Continuous sound needed to clear a warning, so a single cough doesn't flicker it. */
  clearAfterMs: number
  /** No readings at all for this long means capture itself has stalled. */
  stallAfterMs: number
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  threshold: 0.003,
  warnAfterMs: 20_000,
  clearAfterMs: 750,
  stallAfterMs: 5_000
}

export type SilenceState =
  | { kind: 'ok' }
  | { kind: 'silent'; sinceMs: number }
  | { kind: 'stalled'; sinceMs: number }

export class SilenceDetector {
  private quietSince: number | null = null
  private loudSince: number | null = null
  private lastReadingAt: number | null = null
  private warning = false
  private startedAt: number

  constructor(
    nowMs: number,
    private readonly options: SilenceOptions = DEFAULT_SILENCE_OPTIONS
  ) {
    this.startedAt = nowMs
  }

  /** Feed one level reading. */
  observe(rms: number, nowMs: number): SilenceState {
    this.lastReadingAt = nowMs
    const quiet = !Number.isFinite(rms) || rms < this.options.threshold

    if (quiet) {
      this.loudSince = null
      if (this.quietSince === null) this.quietSince = nowMs
      if (nowMs - this.quietSince >= this.options.warnAfterMs) this.warning = true
    } else if (this.warning) {
      // Already warning: require sound to hold for a moment before clearing.
      if (this.loudSince === null) this.loudSince = nowMs
      if (nowMs - this.loudSince >= this.options.clearAfterMs) {
        this.warning = false
        this.quietSince = null
        this.loudSince = null
      }
    } else {
      // Short pauses between sentences never add up to a warning.
      this.quietSince = null
      this.loudSince = null
    }
    return this.state(nowMs)
  }

  /** The current state, including a stall when readings stop arriving. */
  state(nowMs: number): SilenceState {
    const last = this.lastReadingAt ?? this.startedAt
    if (nowMs - last >= this.options.stallAfterMs) return { kind: 'stalled', sinceMs: last }
    if (this.warning && this.quietSince !== null) return { kind: 'silent', sinceMs: this.quietSince }
    return { kind: 'ok' }
  }

  /** Start over: after resuming from a pause, or once capture restarts. */
  reset(nowMs: number): void {
    this.quietSince = null
    this.loudSince = null
    this.lastReadingAt = null
    this.warning = false
    this.startedAt = nowMs
  }
}

/** A plain-language warning for the recording screen, or null when all is well. */
export function describeSilence(state: SilenceState, nowMs: number): string | null {
  if (state.kind === 'ok') return null
  const seconds = Math.max(0, Math.round((nowMs - state.sinceMs) / 1000))
  if (state.kind === 'silent') {
    return `No sound picked up for ${seconds} seconds. Is the microphone muted, or the wrong input selected?`
  }
  return `The microphone stopped sending audio ${seconds} seconds ago. It may have been unplugged or taken over by another app.`
}
