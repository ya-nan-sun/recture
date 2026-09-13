import { describe, expect, it } from 'vitest'
import { TranscriptionQueue, type QueueSnapshot, type TranscriptionJob } from '@main/transcription/queue'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const job = (lectureId: string): TranscriptionJob => ({ lectureId, reason: 'recorded' })

/** A run() whose jobs only finish when the test releases them. */
function harness() {
  const started: string[] = []
  const finished: string[] = []
  const release = new Map<string, () => void>()
  const signals = new Map<string, AbortSignal>()
  let active = 0
  let maxActive = 0

  const run = async (j: TranscriptionJob, signal: AbortSignal): Promise<void> => {
    started.push(j.lectureId)
    signals.set(j.lectureId, signal)
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      await new Promise<void>((resolve, reject) => {
        release.set(j.lectureId, resolve)
        signal.addEventListener('abort', () => reject(new Error(`aborted: ${String(signal.reason)}`)), { once: true })
      })
      finished.push(j.lectureId)
    } finally {
      active -= 1
    }
  }

  return { run, started, finished, release, signals, maxActive: () => maxActive }
}

describe('TranscriptionQueue', () => {
  it('runs one job at a time, in the order they were queued', async () => {
    const h = harness()
    const queue = new TranscriptionQueue({ run: h.run })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    queue.enqueue(job('c'))
    await tick()
    expect(h.started).toEqual(['a'])

    h.release.get('a')!()
    await tick()
    expect(h.started).toEqual(['a', 'b'])

    h.release.get('b')!()
    await tick()
    h.release.get('c')!()
    await queue.idle()

    expect(h.finished).toEqual(['a', 'b', 'c'])
    expect(h.maxActive()).toBe(1)
  })

  it('never queues the same lecture twice', async () => {
    const h = harness()
    const queue = new TranscriptionQueue({ run: h.run })
    expect(queue.enqueue(job('a')).accepted).toBe(true)
    expect(queue.enqueue(job('b')).accepted).toBe(true)

    // Asking again, whether running or waiting, must not transcribe (and bill) twice.
    expect(queue.enqueue(job('a'))).toEqual({ accepted: false, position: 0 })
    expect(queue.enqueue(job('b'))).toEqual({ accepted: false, position: 1 })

    h.release.get('a')!()
    await tick()
    h.release.get('b')!()
    await queue.idle()
    expect(h.started).toEqual(['a', 'b'])
  })

  it("reports each lecture's place in line", async () => {
    const h = harness()
    const queue = new TranscriptionQueue({ run: h.run })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    queue.enqueue(job('c'))

    expect(queue.position('a')).toBe(0)
    expect(queue.position('b')).toBe(1)
    expect(queue.position('c')).toBe(2)
    expect(queue.position('missing')).toBe(-1)
    expect(queue.snapshot()).toEqual({
      running: { lectureId: 'a', startedAt: expect.any(String) },
      waiting: ['b', 'c']
    })
    await queue.shutdown(50)
  })

  it('drops a waiting job that is cancelled', async () => {
    const h = harness()
    const queue = new TranscriptionQueue({ run: h.run })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    queue.enqueue(job('c'))

    expect(await queue.cancel('b')).toBe(true)
    h.release.get('a')!()
    await tick()
    h.release.get('c')!()
    await queue.idle()

    expect(h.started).toEqual(['a', 'c'])
  })

  it('aborts a running job that is cancelled, and moves on once it lets go', async () => {
    const h = harness()
    const queue = new TranscriptionQueue({ run: h.run })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    await tick()

    expect(await queue.cancel('a')).toBe(true)
    expect(h.signals.get('a')!.aborted).toBe(true)
    expect(h.signals.get('a')!.reason).toBe('cancelled')

    await tick()
    expect(h.started).toEqual(['a', 'b'])
    expect(h.finished).toEqual([])
    await queue.shutdown(50)
  })

  it('reports false when cancelling a lecture that is not queued', async () => {
    const queue = new TranscriptionQueue({ run: async () => undefined })
    expect(await queue.cancel('nothing')).toBe(false)
  })

  it('keeps going after a job fails', async () => {
    const order: string[] = []
    const queue = new TranscriptionQueue({
      run: async (j) => {
        order.push(j.lectureId)
        if (j.lectureId === 'bad') throw new Error('boom')
      }
    })
    queue.enqueue(job('bad'))
    queue.enqueue(job('good'))
    await queue.idle()
    expect(order).toEqual(['bad', 'good'])
  })

  it('on shutdown aborts the running job, drops the rest, and accepts nothing new', async () => {
    const h = harness()
    const queue = new TranscriptionQueue({ run: h.run })
    queue.enqueue(job('a'))
    queue.enqueue(job('b'))
    await tick()

    await queue.shutdown()
    expect(h.signals.get('a')!.aborted).toBe(true)
    expect(h.signals.get('a')!.reason).toBe('shutdown')

    await tick()
    expect(h.started).toEqual(['a'])
    expect(queue.enqueue(job('c')).accepted).toBe(false)
    expect(queue.snapshot()).toEqual({ running: null, waiting: [] })
  })

  it('does not hang shutdown on a job that ignores its abort signal', async () => {
    const queue = new TranscriptionQueue({ run: () => new Promise<void>(() => undefined) })
    queue.enqueue(job('stuck'))
    const startedAt = Date.now()
    await queue.shutdown(50)
    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  it('tells listeners what changed, and survives a listener that throws', async () => {
    const snapshots: QueueSnapshot[] = []
    const h = harness()
    let first = true
    const queue = new TranscriptionQueue({
      run: h.run,
      onChange: (snapshot) => {
        snapshots.push(snapshot)
        if (first) {
          first = false
          throw new Error('bad listener')
        }
      }
    })

    queue.enqueue(job('a'))
    await tick()
    expect(snapshots.at(-1)).toEqual({ running: { lectureId: 'a', startedAt: expect.any(String) }, waiting: [] })

    h.release.get('a')!()
    await queue.idle()
    expect(snapshots.at(-1)).toEqual({ running: null, waiting: [] })
  })
})
