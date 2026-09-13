import { describe, expect, it } from 'vitest'
import { SETUP_CHOICES, matchSetup, setupStatus, shouldShowSetup } from '@shared/setup'

const choice = (id: string) => SETUP_CHOICES.find((c) => c.id === id)!

describe('setup choices', () => {
  it('offers the four setups the README describes', () => {
    expect(SETUP_CHOICES.map((c) => [c.id, c.liveProvider, c.batchProvider])).toEqual([
      ['free-private', 'none', 'whisper-local'],
      ['free-live', 'deepgram-live', 'whisper-local'],
      ['fast', 'none', 'deepgram-batch'],
      ['everything', 'deepgram-live', 'deepgram-batch']
    ])
  })

  it('asks for Python only when transcripts are made on the computer, and a key whenever Deepgram is used', () => {
    expect(SETUP_CHOICES.map((c) => [c.id, c.needsPython, c.needsDeepgramKey])).toEqual([
      ['free-private', true, false],
      ['free-live', true, true],
      ['fast', false, true],
      ['everything', false, true]
    ])
  })

  it('only calls the setup that sends nothing anywhere free', () => {
    expect(SETUP_CHOICES.filter((c) => c.cost === 'Free').map((c) => c.id)).toEqual(['free-private'])
  })

  it('recognises which setup the current settings are', () => {
    for (const c of SETUP_CHOICES) {
      expect(matchSetup({ liveProvider: c.liveProvider, batchProvider: c.batchProvider })).toBe(c.id)
    }
  })
})

describe('shouldShowSetup', () => {
  it('shows on a fresh install', () => {
    expect(shouldShowSetup({ setupComplete: false }, 0)).toBe(true)
  })

  it('never shows again once finished or put off', () => {
    expect(shouldShowSetup({ setupComplete: true }, 0)).toBe(false)
  })

  it('does not interrupt someone who already has classes', () => {
    // An existing library from before setup existed has no setupComplete flag.
    expect(shouldShowSetup({ setupComplete: false }, 3)).toBe(false)
  })
})

describe('setupStatus', () => {
  it('is ready when everything the setup needs is in place', () => {
    expect(setupStatus(choice('free-private'), { hasDeepgramKey: false, localAvailable: true })).toEqual({
      ready: true,
      checking: false,
      missing: []
    })
    expect(setupStatus(choice('fast'), { hasDeepgramKey: true, localAvailable: false })).toEqual({
      ready: true,
      checking: false,
      missing: []
    })
  })

  it('lists what is missing', () => {
    expect(setupStatus(choice('free-live'), { hasDeepgramKey: false, localAvailable: false })).toEqual({
      ready: false,
      checking: false,
      missing: ['python', 'deepgram-key']
    })
  })

  it('is not ready while it is still checking the computer', () => {
    expect(setupStatus(choice('free-private'), { hasDeepgramKey: false, localAvailable: null })).toEqual({
      ready: false,
      checking: true,
      missing: []
    })
    // Deepgram-only setups do not wait on that check.
    expect(setupStatus(choice('everything'), { hasDeepgramKey: true, localAvailable: null }).checking).toBe(false)
  })
})
