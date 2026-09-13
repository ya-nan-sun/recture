import { useEffect, useState, type ReactNode } from 'react'
import type { LectureRecord, LectureStatus } from '@shared/types'
import { computeElapsedSec, type ElapsedInput } from '@shared/elapsed'
import { levelToMeter } from '../audio/recorder'

export function StatusChip({ lecture }: { lecture: LectureRecord }): ReactNode {
  const map: Record<LectureStatus, { label: string; className: string }> = {
    recording: { label: 'Recording', className: 'chip danger' },
    importing: { label: 'Importing', className: 'chip busy' },
    queued: { label: 'Waiting to transcribe', className: 'chip busy' },
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
 * Seconds of lecture so far, ticking every second.
 *
 * Derived from the recording state (start time, pauses, and any audio a resumed
 * lecture already had) rather than from segment broadcasts, which arrive only
 * every ~45 seconds and would leave the clock visibly frozen. Frozen on purpose
 * while paused.
 */
export function useElapsed(state: ElapsedInput | null | undefined): number {
  const [seconds, setSeconds] = useState(() => computeElapsedSec(state, Date.now()))

  useEffect(() => {
    const update = (): void => setSeconds(computeElapsedSec(state, Date.now()))
    update()
    if (!state?.active || state.paused) return
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [state])

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
