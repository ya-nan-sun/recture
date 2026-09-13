/**
 * Everything the record screen might need to warn about, combined into one
 * ordered list: setup problems, disk and battery, a silent or disconnected
 * microphone, and a recording paused by sleep.
 *
 * Pure, so what is shown when (and in what order) is tested directly.
 */

import { describeSilence, type SilenceState } from './silence'
import type { BatteryAssessment, DiskAssessment, ReadinessIssue, ResourceLevel } from './readiness'

export type AlertTone = 'danger' | 'warn' | 'info'
export type AlertAction = 'settings' | 'reconnect' | 'resume'

export interface RecordingAlert {
  id: string
  tone: AlertTone
  message: string
  action?: AlertAction
}

export interface AlertInput {
  recording: boolean
  paused: boolean
  nowMs: number
  silence: SilenceState
  /** The saved microphone was missing, so the system default is recording. */
  micFellBack: boolean
  /** The computer slept during this recording. */
  sleptDuringRecording: boolean
  disk: DiskAssessment | null
  battery: BatteryAssessment
  readiness: ReadinessIssue[]
}

const TONE_ORDER: Record<AlertTone, number> = { danger: 0, warn: 1, info: 2 }

const resourceTone = (level: ResourceLevel): AlertTone | null =>
  level === 'critical' ? 'danger' : level === 'low' ? 'warn' : null

export const ACTION_LABELS: Record<AlertAction, string> = {
  settings: 'Open Settings',
  reconnect: 'Reconnect microphone',
  resume: 'Resume'
}

export function recordingAlerts(input: AlertInput): RecordingAlert[] {
  const alerts: RecordingAlert[] = []

  if (input.recording) {
    if (input.paused && input.sleptDuringRecording) {
      alerts.push({
        id: 'slept',
        tone: 'warn',
        action: 'resume',
        message:
          'Recording paused while the computer was asleep. Resume to carry on, or stop if the lecture is over. Everything before the sleep is saved.'
      })
    }

    // A pause is meant to be quiet, so silence only counts while recording.
    if (!input.paused) {
      const message = describeSilence(input.silence, input.nowMs)
      if (message && input.silence.kind === 'stalled') {
        alerts.push({ id: 'mic-stalled', tone: 'danger', action: 'reconnect', message })
      } else if (message) {
        alerts.push({ id: 'mic-silent', tone: 'warn', message })
      }
    }

    if (input.micFellBack) {
      alerts.push({
        id: 'mic-fallback',
        tone: 'info',
        message:
          "The microphone you chose in Mic check isn't connected, so this lecture is recording from the system default."
      })
    }
  }

  const diskTone = input.disk ? resourceTone(input.disk.level) : null
  if (diskTone && input.disk?.message) {
    alerts.push({ id: 'disk', tone: diskTone, message: input.disk.message })
  }

  const batteryTone = resourceTone(input.battery.level)
  if (batteryTone && input.battery.message) {
    alerts.push({ id: 'battery', tone: batteryTone, message: input.battery.message })
  }

  for (const issue of input.readiness) {
    alerts.push({
      id: issue.id,
      tone: issue.severity === 'warning' ? 'warn' : 'info',
      message: issue.message,
      ...(issue.fixInSettings ? { action: 'settings' as const } : {})
    })
  }

  // Stable sort: most serious first, original order within a tone.
  return alerts
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => TONE_ORDER[a.alert.tone] - TONE_ORDER[b.alert.tone] || a.index - b.index)
    .map(({ alert }) => alert)
}
