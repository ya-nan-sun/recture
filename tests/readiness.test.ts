import { describe, expect, it } from 'vitest'
import { BYTES_PER_RECORDED_HOUR, assessBattery, assessDiskSpace, computeReadiness } from '@shared/readiness'
import type { ProviderAvailability } from '@shared/types'

const localReady: ProviderAvailability = {
  id: 'whisper-local',
  available: true,
  detail: 'Ready.',
  sendsAudioOffDevice: false
}
const localMissing: ProviderAvailability = {
  id: 'whisper-local',
  available: false,
  detail: 'faster-whisper is not installed.',
  sendsAudioOffDevice: false
}

describe('computeReadiness', () => {
  it('has nothing to say when everything is set up', () => {
    const issues = computeReadiness({
      settings: { batchProvider: 'whisper-local', liveProvider: 'none' },
      hasDeepgramKey: false,
      providers: [localReady]
    })
    expect(issues).toEqual([])
  })

  it('warns before recording when cloud transcription has no key', () => {
    // Regression: this used to surface only after the lecture, as an instant failure.
    const issues = computeReadiness({
      settings: { batchProvider: 'deepgram-batch', liveProvider: 'none' },
      hasDeepgramKey: false,
      providers: []
    })
    expect(issues.map((i) => i.id)).toEqual(['final-no-key'])
    expect(issues[0]!.severity).toBe('warning')
    expect(issues[0]!.fixInSettings).toBe(true)
    expect(issues[0]!.message).toMatch(/still be saved/)
  })

  it('mentions a keyless live draft as information, not a warning', () => {
    const issues = computeReadiness({
      settings: { batchProvider: 'whisper-local', liveProvider: 'deepgram-live' },
      hasDeepgramKey: false,
      providers: [localReady]
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ id: 'live-no-key', severity: 'info' })
  })

  it('explains a key lost in the rename, instead of two generic warnings', () => {
    const issues = computeReadiness({
      settings: { batchProvider: 'deepgram-batch', liveProvider: 'deepgram-live', apiKeyReentryNotice: true },
      hasDeepgramKey: false,
      providers: []
    })
    expect(issues.map((i) => i.id)).toEqual(['key-reentry'])
    expect(issues[0]!.message).toMatch(/LectureRec/)
  })

  it('drops the rename notice once a key is saved', () => {
    const issues = computeReadiness({
      settings: { batchProvider: 'deepgram-batch', liveProvider: 'deepgram-live', apiKeyReentryNotice: true },
      hasDeepgramKey: true,
      providers: []
    })
    expect(issues).toEqual([])
  })

  it('passes on why on-device transcription is not ready', () => {
    const issues = computeReadiness({
      settings: { batchProvider: 'whisper-local', liveProvider: 'none' },
      hasDeepgramKey: false,
      providers: [localMissing]
    })
    expect(issues.map((i) => i.id)).toEqual(['final-local-unavailable'])
    expect(issues[0]!.message).toMatch(/faster-whisper is not installed/)
  })

  it('says nothing about a provider it has not heard back from yet', () => {
    const issues = computeReadiness({
      settings: { batchProvider: 'whisper-local', liveProvider: 'none' },
      hasDeepgramKey: false,
      providers: []
    })
    expect(issues).toEqual([])
  })
})

describe('assessDiskSpace', () => {
  const hoursOfSpace = (hours: number): number => hours * BYTES_PER_RECORDED_HOUR * 2

  it('is fine with plenty of space', () => {
    expect(assessDiskSpace(500 * 1024 ** 3)).toMatchObject({ level: 'ok', message: null })
  })

  it('warns when fewer than ten hours of recording will fit', () => {
    const result = assessDiskSpace(hoursOfSpace(5))
    expect(result.level).toBe('low')
    expect(result.message).toMatch(/About 5 hours/)
  })

  it('is critical when less than two hours will fit', () => {
    expect(assessDiskSpace(hoursOfSpace(1)).level).toBe('critical')
    const halfHour = assessDiskSpace(hoursOfSpace(0.5))
    expect(halfHour.level).toBe('critical')
    expect(halfHour.message).toMatch(/30 minutes/)
  })

  it('budgets for transcription as well as the recording itself', () => {
    // 10 hours of raw audio fits in the space, but assembling it doubles the need.
    expect(assessDiskSpace(10 * BYTES_PER_RECORDED_HOUR).level).toBe('low')
  })

  it('never reports negative or nonsense amounts', () => {
    expect(assessDiskSpace(0)).toMatchObject({ level: 'critical', hoursLeft: 0 })
    expect(assessDiskSpace(Number.NaN)).toMatchObject({ level: 'critical', hoursLeft: 0 })
  })
})

describe('assessBattery', () => {
  it('stays quiet while charging, or when the battery cannot be read', () => {
    expect(assessBattery({ level: 0.05, charging: true })).toEqual({ level: 'ok', message: null })
    expect(assessBattery(null)).toEqual({ level: 'ok', message: null })
  })

  it('is fine above 20%', () => {
    expect(assessBattery({ level: 0.5, charging: false }).level).toBe('ok')
  })

  it('warns at 20% on battery', () => {
    const result = assessBattery({ level: 0.2, charging: false })
    expect(result.level).toBe('low')
    expect(result.message).toMatch(/20%/)
  })

  it('is critical at 10% on battery, and says the recording is kept', () => {
    const result = assessBattery({ level: 0.08, charging: false })
    expect(result.level).toBe('critical')
    expect(result.message).toMatch(/kept up to that point/)
  })
})
