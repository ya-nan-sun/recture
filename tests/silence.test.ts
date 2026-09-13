import { describe, expect, it } from 'vitest'
import { SilenceDetector, describeSilence, type SilenceState } from '@shared/silence'

const QUIET = 0.0005
const LOUD = 0.05
const FRAME_MS = 125 // how often the recorder reports a level

/** Feed a steady level for `forMs`, returning every state seen along the way. */
function feed(detector: SilenceDetector, rms: number, fromMs: number, forMs: number): SilenceState[] {
  const states: SilenceState[] = []
  for (let t = fromMs; t <= fromMs + forMs; t += FRAME_MS) states.push(detector.observe(rms, t))
  return states
}

describe('SilenceDetector', () => {
  it('stays quiet about ordinary speech', () => {
    const detector = new SilenceDetector(0)
    expect(feed(detector, LOUD, 0, 60_000).every((s) => s.kind === 'ok')).toBe(true)
  })

  it('warns once the room has been silent for 20 seconds', () => {
    const detector = new SilenceDetector(0)
    expect(feed(detector, QUIET, 0, 19_875).at(-1)).toEqual({ kind: 'ok' })
    expect(feed(detector, QUIET, 20_000, 500).at(-1)).toEqual({ kind: 'silent', sinceMs: 0 })
  })

  it('never adds short pauses between sentences into a warning', () => {
    const detector = new SilenceDetector(0)
    const seen: SilenceState[] = []
    let t = 0
    for (let round = 0; round < 6; round++) {
      seen.push(...feed(detector, QUIET, t, 15_000))
      t += 15_125
      seen.push(...feed(detector, LOUD, t, 1_000))
      t += 1_125
    }
    expect(seen.some((s) => s.kind !== 'ok')).toBe(false)
  })

  it('clears only once sound has held for a moment', () => {
    const detector = new SilenceDetector(0)
    feed(detector, QUIET, 0, 25_000)
    expect(detector.state(25_000).kind).toBe('silent')

    // A brief sound is not enough to call it fixed...
    expect(feed(detector, LOUD, 25_125, 250).at(-1)!.kind).toBe('silent')
    // ...but sound that holds is.
    expect(feed(detector, LOUD, 25_500, 1_000).at(-1)).toEqual({ kind: 'ok' })
  })

  it('keeps warning, from the original moment, if the sound was only a blip', () => {
    const detector = new SilenceDetector(0)
    feed(detector, QUIET, 0, 25_000)
    feed(detector, LOUD, 25_125, 250)
    expect(feed(detector, QUIET, 25_500, 2_000).at(-1)).toEqual({ kind: 'silent', sinceMs: 0 })
  })

  it('reports a stall when level readings stop arriving', () => {
    const detector = new SilenceDetector(0)
    detector.observe(LOUD, 1_000)
    expect(detector.state(4_000)).toEqual({ kind: 'ok' })
    expect(detector.state(6_000)).toEqual({ kind: 'stalled', sinceMs: 1_000 })
  })

  it('starts over after a reset, e.g. when resuming from a pause', () => {
    const detector = new SilenceDetector(0)
    feed(detector, QUIET, 0, 25_000)
    detector.reset(26_000)
    expect(detector.state(26_000)).toEqual({ kind: 'ok' })
    expect(feed(detector, QUIET, 26_000, 19_000).at(-1)).toEqual({ kind: 'ok' })
  })
})

describe('describeSilence', () => {
  it('says nothing when all is well', () => {
    expect(describeSilence({ kind: 'ok' }, 10_000)).toBeNull()
  })

  it('tells the student how long the room has been silent, and what to check', () => {
    const message = describeSilence({ kind: 'silent', sinceMs: 0 }, 25_000)
    expect(message).toMatch(/No sound picked up for 25 seconds/)
    expect(message).toMatch(/muted|wrong input/)
  })

  it('explains a stalled microphone differently from a quiet room', () => {
    expect(describeSilence({ kind: 'stalled', sinceMs: 1_000 }, 7_000)).toMatch(/stopped sending audio 6 seconds ago/)
  })
})
