/**
 * Keeps a recording alive through the laptop's power management.
 *
 * Two things used to go wrong. A laptop left on the desk would go to sleep
 * mid-lecture, silently ending the recording. And a lid closed mid-lecture
 * left the open segment unflushed: if the battery then died while asleep, up
 * to a whole segment was lost.
 *
 * No Electron imports, so the rules are unit-tested with fakes; index.ts wires
 * in `powerSaveBlocker` and `powerMonitor`.
 */

import type { PowerNotice } from '@shared/types'

export type { PowerNotice }

export interface SleepBlocker {
  start(): number
  stop(id: number): void
  isStarted(id: number): boolean
}

export interface PowerGuardHooks {
  isRecording(): boolean
  isPaused(): boolean
  /** Pause the recording, flushing and checksumming the open segment. */
  pause(): Promise<unknown>
  notify(notice: PowerNotice): void
}

export class PowerGuard {
  private blockerId: number | null = null
  private recordingAtSuspend = false
  private pausedForSleep = false

  constructor(
    private readonly blocker: SleepBlocker,
    private readonly hooks: PowerGuardHooks
  ) {}

  /** Whether the system is currently being kept awake. */
  get isBlocking(): boolean {
    return this.blockerId !== null && this.blocker.isStarted(this.blockerId)
  }

  /**
   * Follow the recording state. Keeps the system awake for exactly as long as
   * a recording is open, including while it is paused for a break.
   */
  setRecording(active: boolean): void {
    if (active && this.blockerId === null) {
      this.blockerId = this.blocker.start()
    } else if (!active && this.blockerId !== null) {
      this.release()
    }
  }

  /**
   * The system is going to sleep anyway (lid closed, battery critical).
   *
   * Pause, so the open segment is flushed and checksummed before the process
   * is frozen. Recording does not resume by itself on wake: a lid closed at
   * the end of a lecture should not quietly start recording the student's
   * commute.
   */
  async onSuspend(): Promise<void> {
    this.recordingAtSuspend = this.hooks.isRecording()
    this.pausedForSleep = false
    if (!this.recordingAtSuspend || this.hooks.isPaused()) return
    try {
      await this.hooks.pause()
      this.pausedForSleep = true
    } catch {
      // Best effort: the segment is still recoverable from disk on next launch.
    }
  }

  onResume(): void {
    if (!this.recordingAtSuspend) return
    this.recordingAtSuspend = false
    // The recording may have been stopped between suspend and resume.
    if (this.hooks.isRecording()) {
      this.hooks.notify({ kind: 'resumed-after-sleep', pausedForSleep: this.pausedForSleep })
    }
    this.pausedForSleep = false
  }

  dispose(): void {
    this.release()
  }

  private release(): void {
    if (this.blockerId === null) return
    try {
      if (this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId)
    } finally {
      this.blockerId = null
    }
  }
}
