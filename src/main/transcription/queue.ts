/**
 * Runs final transcription passes one at a time, independently of recording.
 *
 * Transcription used to run inside the recording controller, which blocked the
 * next recording until the previous lecture had finished transcribing — about
 * 30 minutes for a 90-minute lecture on the local model, long enough to miss
 * the start of a back-to-back class. Stopping a recording now just enqueues a
 * job and returns.
 *
 * Jobs run strictly one at a time: the local model already uses every core, so
 * two in parallel would each finish later than running them back to back.
 */

export type TranscriptionJobReason = 'recorded' | 'retry' | 'resumed' | 'imported'

export interface TranscriptionJob {
  lectureId: string
  reason: TranscriptionJobReason
}

export interface QueueSnapshot {
  running: { lectureId: string; startedAt: string } | null
  waiting: string[]
}

/** Why a running job's signal was aborted. Read it from `signal.reason`. */
export type AbortReason = 'shutdown' | 'cancelled'

export interface QueueOptions {
  /**
   * Performs one job. It owns every status update for its lecture, including
   * after an abort — `signal.reason` tells a shutdown (resume next launch)
   * apart from a deliberate cancellation.
   */
  run: (job: TranscriptionJob, signal: AbortSignal) => Promise<void>
  onChange?: (snapshot: QueueSnapshot) => void
}

interface RunningJob {
  job: TranscriptionJob
  controller: AbortController
  startedAt: string
  done: Promise<void>
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class TranscriptionQueue {
  private waiting: TranscriptionJob[] = []
  private running: RunningJob | null = null
  private closed = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly options: QueueOptions) {}

  snapshot(): QueueSnapshot {
    return {
      running: this.running ? { lectureId: this.running.job.lectureId, startedAt: this.running.startedAt } : null,
      waiting: this.waiting.map((j) => j.lectureId)
    }
  }

  has(lectureId: string): boolean {
    return this.isRunning(lectureId) || this.waiting.some((j) => j.lectureId === lectureId)
  }

  isRunning(lectureId: string): boolean {
    return this.running?.job.lectureId === lectureId
  }

  /** 0 = running now, 1 = next up, and so on; -1 = not queued. */
  position(lectureId: string): number {
    if (this.isRunning(lectureId)) return 0
    const index = this.waiting.findIndex((j) => j.lectureId === lectureId)
    return index < 0 ? -1 : index + 1
  }

  get isClosed(): boolean {
    return this.closed
  }

  enqueue(job: TranscriptionJob): { accepted: boolean; position: number } {
    if (this.closed) return { accepted: false, position: -1 }
    // One job per lecture: asking twice must not transcribe (and bill) twice.
    if (this.has(job.lectureId)) return { accepted: false, position: this.position(job.lectureId) }
    this.waiting.push(job)
    this.emit()
    this.pump()
    return { accepted: true, position: this.position(job.lectureId) }
  }

  /**
   * Drop a waiting job, or abort the running one and wait (bounded) for it to
   * let go of its files — deleting a lecture folder that a transcriber still
   * has open fails on Windows.
   */
  async cancel(lectureId: string, timeoutMs = 10_000): Promise<boolean> {
    const index = this.waiting.findIndex((j) => j.lectureId === lectureId)
    if (index >= 0) {
      this.waiting.splice(index, 1)
      this.emit()
      this.resolveIdle()
      return true
    }
    const running = this.running
    if (running && running.job.lectureId === lectureId) {
      running.controller.abort('cancelled' satisfies AbortReason)
      await Promise.race([running.done, delay(timeoutMs)])
      return true
    }
    return false
  }

  /** Resolves once nothing is running or waiting. */
  idle(): Promise<void> {
    if (!this.running && this.waiting.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * Stop for app quit: abort the running job, forget the waiting ones and
   * accept nothing further. Waiting lectures keep their `queued` status in the
   * index, so they — and the aborted one — resume on next launch.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    this.closed = true
    this.waiting = []
    const running = this.running
    if (running) {
      running.controller.abort('shutdown' satisfies AbortReason)
      await Promise.race([running.done, delay(timeoutMs)])
    }
    this.emit()
    this.resolveIdle()
  }

  private pump(): void {
    if (this.running || this.closed) return
    const job = this.waiting.shift()
    if (!job) {
      this.resolveIdle()
      return
    }

    const controller = new AbortController()
    const entry: RunningJob = { job, controller, startedAt: new Date().toISOString(), done: Promise.resolve() }
    this.running = entry
    this.emit()

    entry.done = (async () => {
      try {
        await this.options.run(job, controller.signal)
      } catch {
        // run() owns failure handling for its lecture; the queue just moves on.
      } finally {
        if (this.running === entry) this.running = null
        this.emit()
        this.pump()
      }
    })()
  }

  private resolveIdle(): void {
    if (this.running || this.waiting.length > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private emit(): void {
    try {
      this.options.onChange?.(this.snapshot())
    } catch {
      // A broken listener must never stall transcription.
    }
  }
}
