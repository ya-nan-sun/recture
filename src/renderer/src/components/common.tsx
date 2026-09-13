import { useEffect, useState, type ReactNode } from 'react'
import type { LectureRecord, LectureStatus } from '@shared/types'
import { levelToMeter } from '../audio/recorder'

export function StatusChip({ lecture }: { lecture: LectureRecord }): ReactNode {
  const map: Record<LectureStatus, { label: string; className: string }> = {
    recording: { label: 'Recording', className: 'chip danger' },
    assembling: { label: 'Assembling', className: 'chip busy' },
    transcribing: { label: 'Transcribing', className: 'chip busy' },
    complete: { label: 'Ready', className: 'chip ok' },
    needs_transcription: { label: 'Needs transcription', className: 'chip warn' },
    needs_attention: { label: 'Needs attention', className: 'chip danger' }
  }
  const entry = map[lecture.status]
  return (
    <span className={entry.className} title={lecture.statusDetail ?? undefined}>
      {entry.label}
    </span>
  )
}

export function LevelMeter({ peak, rms }: { peak: number; rms: number }): ReactNode {
  const rmsPct = levelToMeter(rms) * 100
  const peakPct = levelToMeter(peak) * 100
  return (
    <div className="meter" role="meter" aria-label="Microphone level" aria-valuenow={Math.round(rmsPct)}>
      <div className="meter-fill" style={{ width: `${rmsPct}%` }} />
      {peakPct > 0 && <div className="meter-peak" style={{ left: `${Math.min(99.5, peakPct)}%` }} />}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: ReactNode
}): ReactNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 14 }}>
          <strong style={{ fontSize: 15 }}>{title}</strong>
          <div className="spacer" />
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Toast({ message, onDone }: { message: string | null; onDone: () => void }): ReactNode {
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDone, 4200)
    return () => clearTimeout(timer)
  }, [message, onDone])

  if (!message) return null
  return <div className="toast">{message}</div>
}

/**
 * Seconds since recording started, ticking every second.
 *
 * Derived from the start timestamp rather than from the main process's state
 * broadcasts: those only fire when a segment is committed (every ~45s), which
 * would leave the on-screen clock visibly frozen mid-lecture.
 */
export function useElapsed(startedAt: string | null, active: boolean): number {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!active || !startedAt) {
      setSeconds(0)
      return
    }
    const startedMs = new Date(startedAt).getTime()
    const update = (): void => setSeconds(Math.max(0, (Date.now() - startedMs) / 1000))
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [startedAt, active])

  return seconds
}

export function Empty({ title, detail }: { title: string; detail?: string }): ReactNode {
  return (
    <div className="empty">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {detail && <div className="faint">{detail}</div>}
    </div>
  )
}
