import { useEffect, useState } from 'react'
import {
  assessBattery,
  assessDiskSpace,
  computeReadiness,
  type BatteryAssessment,
  type DiskAssessment,
  type ReadinessIssue
} from '@shared/readiness'

interface BatteryManagerLike extends EventTarget {
  level: number
  charging: boolean
}

const BATTERY_OK: BatteryAssessment = { level: 'ok', message: null }

/**
 * What the student should know before and during a recording: transcription
 * setup problems, drive space, and battery.
 *
 * `refreshKey` re-checks the setup when it changes (e.g. on leaving Settings).
 * The setup is not re-checked mid-recording, because checking on-device
 * transcription starts Python.
 */
export function useReadiness(refreshKey: unknown, recording: boolean) {
  const [issues, setIssues] = useState<ReadinessIssue[]>([])
  const [disk, setDisk] = useState<DiskAssessment | null>(null)
  const [battery, setBattery] = useState<BatteryAssessment>(BATTERY_OK)

  useEffect(() => {
    if (recording) return
    let cancelled = false
    void (async () => {
      try {
        const [settings, hasDeepgramKey, providers] = await Promise.all([
          window.recture.settings.get(),
          window.recture.settings.hasApiKey('deepgram'),
          window.recture.settings.providers()
        ])
        if (!cancelled) setIssues(computeReadiness({ settings, hasDeepgramKey, providers }))
      } catch {
        // Keep whatever was known before rather than inventing a problem.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey, recording])

  // Checked more often while recording, when the space is actually being used.
  useEffect(() => {
    let cancelled = false
    const check = async (): Promise<void> => {
      try {
        const space = await window.recture.system.diskSpace()
        if (!cancelled) setDisk(space ? assessDiskSpace(space.freeBytes) : null)
      } catch {
        if (!cancelled) setDisk(null)
      }
    }
    void check()
    const timer = setInterval(() => void check(), recording ? 30_000 : 120_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [refreshKey, recording])

  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> }
    if (typeof nav.getBattery !== 'function') return
    let manager: BatteryManagerLike | null = null
    let cancelled = false
    const update = (): void => {
      if (manager && !cancelled) setBattery(assessBattery({ level: manager.level, charging: manager.charging }))
    }
    nav
      .getBattery()
      .then((found) => {
        if (cancelled) return
        manager = found
        update()
        found.addEventListener('levelchange', update)
        found.addEventListener('chargingchange', update)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      manager?.removeEventListener('levelchange', update)
      manager?.removeEventListener('chargingchange', update)
    }
  }, [])

  return { issues, disk, battery }
}
