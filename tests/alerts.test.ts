import { describe, expect, it } from 'vitest'
import { recordingAlerts, type AlertInput } from '@shared/alerts'
import { assessDiskSpace, BYTES_PER_RECORDED_HOUR, type ReadinessIssue } from '@shared/readiness'

const calm: AlertInput = {
  recording: false,
  paused: false,
  nowMs: 60_000,
  silence: { kind: 'ok' },
  micFellBack: false,
  sleptDuringRecording: false,
  disk: assessDiskSpace(500 * 1024 ** 3),
  battery: { level: 'ok', message: null },
  readiness: []
}

const noKey: ReadinessIssue = {
  id: 'final-no-key',
  severity: 'warning',
  fixInSettings: true,
  message: 'No API key.'
}

const ids = (input: Partial<AlertInput>): string[] => recordingAlerts({ ...calm, ...input }).map((a) => a.id)

describe('recordingAlerts', () => {
  it('shows nothing when all is well', () => {
    expect(recordingAlerts(calm)).toEqual([])
    expect(recordingAlerts({ ...calm, recording: true })).toEqual([])
  })

  it('warns about setup problems before recording, with a way to fix them', () => {
    const [alert] = recordingAlerts({ ...calm, readiness: [noKey] })
    expect(alert).toEqual({ id: 'final-no-key', tone: 'warn', message: 'No API key.', action: 'settings' })
  })

  it('warns about a silent room only while actually recording', () => {
    const silence = { kind: 'silent', sinceMs: 0 } as const
    expect(ids({ silence })).toEqual([])
    expect(ids({ silence, recording: true })).toEqual(['mic-silent'])
    // A pause is meant to be quiet.
    expect(ids({ silence, recording: true, paused: true })).toEqual([])
  })

  it('offers to reconnect a microphone that stopped sending audio', () => {
    const [alert] = recordingAlerts({ ...calm, recording: true, silence: { kind: 'stalled', sinceMs: 50_000 } })
    expect(alert).toMatchObject({ id: 'mic-stalled', tone: 'danger', action: 'reconnect' })
    expect(alert!.message).toMatch(/10 seconds ago/)
  })

  it('offers to resume after the computer slept mid-lecture', () => {
    expect(ids({ recording: true, paused: true, sleptDuringRecording: true })).toEqual(['slept'])
    const [alert] = recordingAlerts({ ...calm, recording: true, paused: true, sleptDuringRecording: true })
    expect(alert).toMatchObject({ tone: 'warn', action: 'resume' })
    // Once resumed, there is nothing left to say.
    expect(ids({ recording: true, paused: false, sleptDuringRecording: true })).toEqual([])
  })

  it('mentions a fallback microphone while recording', () => {
    expect(ids({ recording: true, micFellBack: true })).toEqual(['mic-fallback'])
    expect(ids({ recording: false, micFellBack: true })).toEqual([])
  })

  it('reports low disk and battery whether or not recording', () => {
    const lowDisk = assessDiskSpace(BYTES_PER_RECORDED_HOUR * 2)
    const battery = { level: 'critical', message: 'Battery at 8%.' } as const
    expect(ids({ disk: lowDisk, battery })).toEqual(['disk', 'battery'])
    expect(ids({ disk: lowDisk, battery, recording: true })).toEqual(['disk', 'battery'])
  })

  it('does not complain about disk space it could not read', () => {
    expect(ids({ disk: null })).toEqual([])
  })

  it('puts the most serious problems first', () => {
    const alerts = recordingAlerts({
      ...calm,
      recording: true,
      micFellBack: true,
      readiness: [noKey],
      disk: assessDiskSpace(BYTES_PER_RECORDED_HOUR * 6),
      silence: { kind: 'stalled', sinceMs: 0 }
    })
    expect(alerts.map((a) => [a.id, a.tone])).toEqual([
      ['mic-stalled', 'danger'],
      ['disk', 'warn'],
      ['final-no-key', 'warn'],
      ['mic-fallback', 'info']
    ])
  })
})
