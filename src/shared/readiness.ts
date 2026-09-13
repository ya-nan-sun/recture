/**
 * Things worth telling the student before they press record: a transcription
 * setup that cannot work, a drive about to fill up, a battery about to die.
 *
 * All pure, so the rules are tested directly rather than through the UI.
 */

import type { AppSettings, ProviderAvailability } from './types'

export type IssueSeverity = 'warning' | 'info'

export interface ReadinessIssue {
  id: 'key-reentry' | 'final-no-key' | 'live-no-key' | 'final-local-unavailable'
  severity: IssueSeverity
  message: string
  /** Settings is where this gets fixed. */
  fixInSettings: boolean
}

export interface ReadinessInput {
  settings: Pick<AppSettings, 'batchProvider' | 'liveProvider'> & { apiKeyReentryNotice?: boolean }
  hasDeepgramKey: boolean
  providers: ProviderAvailability[]
}

/**
 * What would go wrong with transcription if the student recorded right now.
 *
 * A missing API key used to surface only after the lecture, when the final
 * pass failed instantly. Anything knowable before recording is said before
 * recording, and always with the reassurance that the audio itself is kept.
 */
export function computeReadiness({ settings, hasDeepgramKey, providers }: ReadinessInput): ReadinessIssue[] {
  const issues: ReadinessIssue[] = []
  const cloudFinal = settings.batchProvider === 'deepgram-batch'
  const cloudLive = settings.liveProvider === 'deepgram-live'

  if (!hasDeepgramKey && (cloudFinal || cloudLive)) {
    if (settings.apiKeyReentryNotice) {
      // One clear explanation, not two generic "no key" warnings.
      issues.push({
        id: 'key-reentry',
        severity: 'warning',
        fixInSettings: true,
        message:
          "Your Deepgram API key couldn't be carried over when the app was renamed from LectureRec. Paste it again in Settings; until then, cloud transcription can't run. Recordings are still saved."
      })
    } else {
      if (cloudFinal) {
        issues.push({
          id: 'final-no-key',
          severity: 'warning',
          fixInSettings: true,
          message:
            'Your final transcript is set to Deepgram, but no API key is saved. Recordings will still be saved, but they will not be transcribed until you add a key or switch to on-device transcription.'
        })
      }
      if (cloudLive) {
        issues.push({
          id: 'live-no-key',
          severity: 'info',
          fixInSettings: true,
          message: "Live draft is on, but no Deepgram API key is saved, so you'll record without live text."
        })
      }
    }
  }

  if (settings.batchProvider === 'whisper-local') {
    // Only speak once the availability check has actually reported back.
    const local = providers.find((p) => p.id === 'whisper-local')
    if (local && !local.available) {
      issues.push({
        id: 'final-local-unavailable',
        severity: 'warning',
        fixInSettings: true,
        message: `On-device transcription isn't ready: ${local.detail} Recordings will still be saved.`
      })
    }
  }

  return issues
}

/** Bytes per hour of 16 kHz mono 16-bit PCM: about 115 MB. */
export const BYTES_PER_RECORDED_HOUR = 16_000 * 2 * 3600

export type ResourceLevel = 'ok' | 'low' | 'critical'

export interface DiskAssessment {
  level: ResourceLevel
  freeBytes: number
  /** Roughly how many more hours can be recorded and transcribed. */
  hoursLeft: number
  message: string | null
}

function describeHours(hours: number): string {
  if (hours >= 1) {
    const whole = Math.floor(hours)
    return `${whole} hour${whole === 1 ? '' : 's'}`
  }
  const minutes = Math.floor(hours * 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Room left for recording on the library's drive. Transcription briefly needs
 * about as much space again as the recording, because it assembles one
 * continuous file, so each hour is budgeted twice.
 */
export function assessDiskSpace(freeBytes: number): DiskAssessment {
  const free = Math.max(0, Number.isFinite(freeBytes) ? freeBytes : 0)
  const hoursLeft = free / (BYTES_PER_RECORDED_HOUR * 2)

  if (hoursLeft < 2) {
    return {
      level: 'critical',
      freeBytes: free,
      hoursLeft,
      message: `Only about ${describeHours(hoursLeft)} of recording space left on this drive. Free up space first, or the recording could stop partway through the lecture.`
    }
  }
  if (hoursLeft < 10) {
    return {
      level: 'low',
      freeBytes: free,
      hoursLeft,
      message: `About ${describeHours(hoursLeft)} of recording space left on this drive.`
    }
  }
  return { level: 'ok', freeBytes: free, hoursLeft, message: null }
}

export interface BatteryReading {
  /** 0..1 */
  level: number
  charging: boolean
}

export interface BatteryAssessment {
  level: ResourceLevel
  message: string | null
}

export function assessBattery(reading: BatteryReading | null | undefined): BatteryAssessment {
  if (!reading || reading.charging || !Number.isFinite(reading.level)) return { level: 'ok', message: null }
  const percent = Math.round(reading.level * 100)
  if (reading.level <= 0.1) {
    return {
      level: 'critical',
      message: `Battery at ${percent}% and not charging. Plug in now. If the laptop shuts down, the recording is kept up to that point.`
    }
  }
  if (reading.level <= 0.2) {
    return {
      level: 'low',
      message: `Battery at ${percent}% and not charging. A long lecture may not fit on this charge.`
    }
  }
  return { level: 'ok', message: null }
}
