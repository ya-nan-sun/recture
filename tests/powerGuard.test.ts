import { describe, expect, it, vi } from 'vitest'
import { PowerGuard, type PowerGuardHooks, type PowerNotice, type SleepBlocker } from '@main/powerGuard'

function fakeBlocker() {
  const active = new Set<number>()
  let next = 1
  const blocker: SleepBlocker = {
    start: vi.fn(() => {
      const id = next++
      active.add(id)
      return id
    }),
    stop: vi.fn((id: number) => void active.delete(id)),
    isStarted: (id: number) => active.has(id)
  }
  return { blocker, activeCount: () => active.size }
}

function fakeRecorder(initial: { recording: boolean; paused: boolean }) {
  const state = { ...initial }
  const notices: PowerNotice[] = []
  const hooks: PowerGuardHooks = {
    isRecording: () => state.recording,
    isPaused: () => state.paused,
    pause: vi.fn(async () => {
      state.paused = true
    }),
    notify: (notice) => notices.push(notice)
  }
  return { state, hooks, notices }
}

describe('PowerGuard sleep prevention', () => {
  it('keeps the computer awake for exactly as long as a recording is open', () => {
    const { blocker, activeCount } = fakeBlocker()
    const guard = new PowerGuard(blocker, fakeRecorder({ recording: false, paused: false }).hooks)

    guard.setRecording(true)
    expect(guard.isBlocking).toBe(true)
    expect(activeCount()).toBe(1)

    guard.setRecording(false)
    expect(guard.isBlocking).toBe(false)
    expect(activeCount()).toBe(0)
  })

  it('takes one hold however many state updates arrive', () => {
    // Recording state is broadcast on every segment, pause and bookmark.
    const { blocker, activeCount } = fakeBlocker()
    const guard = new PowerGuard(blocker, fakeRecorder({ recording: true, paused: false }).hooks)
    for (let i = 0; i < 20; i++) guard.setRecording(true)
    expect(blocker.start).toHaveBeenCalledTimes(1)
    guard.setRecording(false)
    guard.setRecording(false)
    expect(blocker.stop).toHaveBeenCalledTimes(1)
    expect(activeCount()).toBe(0)
  })

  it('releases its hold when disposed', () => {
    const { blocker, activeCount } = fakeBlocker()
    const guard = new PowerGuard(blocker, fakeRecorder({ recording: true, paused: false }).hooks)
    guard.setRecording(true)
    guard.dispose()
    expect(activeCount()).toBe(0)
  })
})

describe('PowerGuard suspend and resume', () => {
  it('pauses a recording before sleep, so the open segment is saved', async () => {
    const recorder = fakeRecorder({ recording: true, paused: false })
    const guard = new PowerGuard(fakeBlocker().blocker, recorder.hooks)
    await guard.onSuspend()
    expect(recorder.hooks.pause).toHaveBeenCalledTimes(1)
    expect(recorder.state.paused).toBe(true)
  })

  it('tells the student on wake, and does not resume by itself', async () => {
    const recorder = fakeRecorder({ recording: true, paused: false })
    const guard = new PowerGuard(fakeBlocker().blocker, recorder.hooks)
    await guard.onSuspend()
    guard.onResume()
    expect(recorder.notices).toEqual([{ kind: 'resumed-after-sleep', pausedForSleep: true }])
    expect(recorder.state.paused).toBe(true)
  })

  it('leaves an already-paused recording alone, but still reports the wake', async () => {
    const recorder = fakeRecorder({ recording: true, paused: true })
    const guard = new PowerGuard(fakeBlocker().blocker, recorder.hooks)
    await guard.onSuspend()
    guard.onResume()
    expect(recorder.hooks.pause).not.toHaveBeenCalled()
    expect(recorder.notices).toEqual([{ kind: 'resumed-after-sleep', pausedForSleep: false }])
  })

  it('does nothing when there was no recording', async () => {
    const recorder = fakeRecorder({ recording: false, paused: false })
    const guard = new PowerGuard(fakeBlocker().blocker, recorder.hooks)
    await guard.onSuspend()
    guard.onResume()
    expect(recorder.hooks.pause).not.toHaveBeenCalled()
    expect(recorder.notices).toEqual([])
  })

  it('stays quiet if the recording was stopped before waking', async () => {
    const recorder = fakeRecorder({ recording: true, paused: false })
    const guard = new PowerGuard(fakeBlocker().blocker, recorder.hooks)
    await guard.onSuspend()
    recorder.state.recording = false
    guard.onResume()
    expect(recorder.notices).toEqual([])
  })

  it('still reports the wake if pausing failed', async () => {
    const recorder = fakeRecorder({ recording: true, paused: false })
    recorder.hooks.pause = vi.fn(async () => {
      throw new Error('disk full')
    })
    const guard = new PowerGuard(fakeBlocker().blocker, recorder.hooks)
    await expect(guard.onSuspend()).resolves.toBeUndefined()
    guard.onResume()
    expect(recorder.notices).toEqual([{ kind: 'resumed-after-sleep', pausedForSleep: false }])
  })

  it('reports each wake once', async () => {
    const recorder = fakeRecorder({ recording: true, paused: false })
    const guard = new PowerGuard(fakeBlocker().blocker, recorder.hooks)
    await guard.onSuspend()
    guard.onResume()
    guard.onResume()
    expect(recorder.notices).toHaveLength(1)
  })
})
