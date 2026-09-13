import { describe, expect, it } from 'vitest'
import { computeElapsedSec, type ElapsedInput } from '@shared/elapsed'

const base: ElapsedInput = {
  active: true,
  startedAt: '2026-09-13T10:00:00.000Z',
  paused: false,
  pausedMs: 0,
  pausedAt: null,
  offsetSec: 0
}

const at = (iso: string): number => Date.parse(iso)

describe('computeElapsedSec', () => {
  it('is zero when nothing is recording', () => {
    expect(computeElapsedSec(null, at('2026-09-13T10:05:00.000Z'))).toBe(0)
    expect(computeElapsedSec({ ...base, active: false }, at('2026-09-13T10:05:00.000Z'))).toBe(0)
  })

  it('counts wall-clock time since the session started', () => {
    expect(computeElapsedSec(base, at('2026-09-13T10:01:30.000Z'))).toBe(90)
  })

  it('leaves out pauses that have already ended', () => {
    expect(computeElapsedSec({ ...base, pausedMs: 30_000 }, at('2026-09-13T10:01:30.000Z'))).toBe(60)
  })

  it('leaves out the pause still in progress', () => {
    const paused = { ...base, paused: true, pausedAt: '2026-09-13T10:01:00.000Z' }
    // Frozen at the moment the pause began, however long the break runs.
    expect(computeElapsedSec(paused, at('2026-09-13T10:01:30.000Z'))).toBe(60)
    expect(computeElapsedSec(paused, at('2026-09-13T10:20:00.000Z'))).toBe(60)
  })

  it('adds the audio a resumed lecture already had', () => {
    expect(computeElapsedSec({ ...base, offsetSec: 600 }, at('2026-09-13T10:00:30.000Z'))).toBe(630)
  })

  it('never runs backwards when the clock reads earlier than the start', () => {
    expect(computeElapsedSec(base, at('2026-09-13T09:59:00.000Z'))).toBe(0)
  })
})
