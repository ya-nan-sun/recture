import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ClassRecord, LectureRecord, LiveStatus, RecordingState } from '@shared/types'
import { formatClock } from '@shared/naming'
import { ACTION_LABELS, type AlertAction, type RecordingAlert } from '@shared/alerts'
import { chooseCaptureDevice } from '@shared/devices'
import { listMicrophones, startCapture, type MicCapture, type MicLevel } from '../audio/recorder'
import { LevelMeter, useElapsed } from './common'
import type { LiveLine } from '../hooks/useRecording'

function liveLabel(status: LiveStatus): { text: string; className: string } {
  switch (status.kind) {
    case 'open':
      return { text: 'Live draft connected', className: 'chip ok' }
    case 'connecting':
      return { text: 'Connecting live draft…', className: 'chip busy' }
    case 'reconnecting':
      return { text: `Reconnecting (${status.attempt})…`, className: 'chip warn' }
    case 'error':
      return { text: status.message, className: 'chip warn' }
    default:
      return { text: 'Live draft off', className: 'chip' }
  }
}

/** Warnings about setup, the microphone, disk and battery, each with its fix. */
export function AlertList({
  alerts,
  onAction
}: {
  alerts: RecordingAlert[]
  onAction: (action: AlertAction) => void
}): ReactNode {
  if (alerts.length === 0) return null
  return (
    <div className="stack" style={{ marginBottom: 12 }}>
      {alerts.map((alert) => (
        <div
          key={alert.id}
          className={`banner ${alert.tone}`}
          role={alert.tone === 'danger' ? 'alert' : 'status'}
          data-alert={alert.id}
        >
          <div className="row" style={{ gap: 10 }}>
            <div style={{ flex: 1 }}>{alert.message}</div>
            {alert.action && <button onClick={() => onAction(alert.action!)}>{ACTION_LABELS[alert.action]}</button>}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Mic check. Opens the microphone *without* recording so the student can
 * confirm the room is being picked up before the professor starts. The
 * microphone chosen here is the one recordings use.
 */
function MicCheck({ disabled }: { disabled: boolean }): ReactNode {
  const [running, setRunning] = useState(false)
  const [level, setLevel] = useState<MicLevel>({ peak: 0, rms: 0 })
  const [device, setDevice] = useState<string>('')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [seenSound, setSeenSound] = useState(false)
  const captureRef = useRef<MicCapture | null>(null)

  const stop = async (): Promise<void> => {
    const capture = captureRef.current
    captureRef.current = null
    setRunning(false)
    setLevel({ peak: 0, rms: 0 })
    if (capture) await capture.stop().catch(() => undefined)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [settings, available] = await Promise.all([
        window.recture.settings.get().catch(() => null),
        listMicrophones().catch(() => [] as MediaDeviceInfo[])
      ])
      if (cancelled) return
      setDevice(settings?.micDeviceId ?? '')
      setDevices(available)
      setLoaded(true)
    })()
    return () => {
      cancelled = true
      void captureRef.current?.stop().catch(() => undefined)
      captureRef.current = null
    }
  }, [])

  const choice = chooseCaptureDevice(device, devices)
  const missing = loaded && choice.fellBack

  const chooseDevice = async (id: string): Promise<void> => {
    setDevice(id)
    if (running) await stop()
    try {
      await window.recture.settings.update({ micDeviceId: id })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggle = async (): Promise<void> => {
    if (running) return stop()
    setError(null)
    setSeenSound(false)
    try {
      captureRef.current = await startCapture({
        deviceId: choice.deviceId,
        onLevel: (next) => {
          setLevel(next)
          if (next.peak > 0.02) setSeenSound(true)
        },
        onError: (err) => setError(err.message)
      })
      setRunning(true)
      // Device names are only available once the microphone has been opened.
      setDevices(await listMicrophones())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <strong>Mic check</strong>
        <div className="spacer" />
        <button onClick={() => void toggle()} disabled={disabled}>
          {running ? 'Stop check' : 'Test microphone'}
        </button>
      </div>
      <LevelMeter peak={level.peak} rms={level.rms} />
      <div className="faint" style={{ marginTop: 8 }}>
        {error ? (
          <span style={{ color: 'var(--danger)' }}>{error}</span>
        ) : running ? (
          seenSound ? (
            <span style={{ color: 'var(--ok)' }}>Picking up sound — you’re good to record.</span>
          ) : (
            'Say something. If the meter stays flat, pick a different input below.'
          )
        ) : (
          'Run a quick check before the lecture starts.'
        )}
      </div>
      {(devices.length > 1 || missing) && (
        <div style={{ marginTop: 10 }}>
          <label htmlFor="mic-device">Record with</label>
          <select id="mic-device" value={device} onChange={(e) => void chooseDevice(e.target.value)}>
            <option value="">System default</option>
            {missing && <option value={device}>Saved microphone (not connected)</option>}
            {devices
              .filter((d) => d.deviceId && d.deviceId !== 'default')
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microphone'}
                </option>
              ))}
          </select>
          <div className="faint" style={{ marginTop: 6 }}>
            {missing ? (
              <span style={{ color: 'var(--warn)' }}>
                The microphone you chose isn’t connected, so recordings will use the system default until it is.
              </span>
            ) : (
              'Recordings use this microphone.'
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export interface RecordPanelProps {
  klass: ClassRecord
  lectures: LectureRecord[]
  state: RecordingState | null
  level: MicLevel
  liveLines: LiveLine[]
  starting: boolean
  cloudLiveEnabled: boolean
  /** Setup, microphone, disk and battery warnings, most serious first. */
  alerts: RecordingAlert[]
  onAlertAction: (action: AlertAction) => void
  onStart: (lectureId: string | null) => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
  /** Flag the current moment, with an optional note. */
  onBookmark: (note: string) => void
  onNewLecture: () => void
  /** Import recordings made elsewhere: a phone, Zoom, Panopto. */
  onImport: () => void
}

export function RecordPanel(props: RecordPanelProps): ReactNode {
  const { klass, lectures, state, level, liveLines, starting, onStart, onStop, onPause, onResume, onBookmark } = props
  const [target, setTarget] = useState<string>('')
  const feedRef = useRef<HTMLDivElement>(null)
  const recording = Boolean(state?.active)
  const elapsed = useElapsed(state)
  const paused = Boolean(state?.paused)
  const [note, setNote] = useState('')

  const markMoment = (): void => {
    onBookmark(note)
    setNote('')
  }

  // Keep the live feed pinned to the newest line unless the student scrolled up.
  useEffect(() => {
    const el = feedRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [liveLines])

  const openable = useMemo(
    // Only lectures that are neither recording nor waiting to transcribe can take more audio.
    () => lectures.filter((l) => l.status === 'needs_transcription'),
    [lectures]
  )
  const live = liveLabel(state?.live ?? { kind: 'disabled' })
  const alertList = <AlertList alerts={props.alerts} onAction={props.onAlertAction} />

  if (recording) {
    return (
      <>
        {alertList}
        <div className="card">
          <div className="row" style={{ marginBottom: 14 }}>
            {paused ? <span className="chip warn">Paused</span> : <span className="rec-dot" />}
            <div>
              <div className="elapsed">{formatClock(elapsed)}</div>
              <div className="faint">
                {state?.className} · {state?.lectureTitle}
              </div>
            </div>
            <div className="spacer" />
            {paused ? (
              <button onClick={onResume}>Resume</button>
            ) : (
              <button onClick={onPause} title="Pause for a break without ending the lecture">
                Pause
              </button>
            )}
            <button className="danger" onClick={onStop}>
              Stop &amp; transcribe
            </button>
          </div>

          <LevelMeter peak={level.peak} rms={level.rms} />

          <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
            <span className="chip ok">
              {state?.segmentsWritten ?? 0} segment{(state?.segmentsWritten ?? 0) === 1 ? '' : 's'} saved
            </span>
            <span className="chip">{(((state?.bytesWritten ?? 0) / 1_048_576) || 0).toFixed(1)} MB on disk</span>
            <span className={live.className}>{live.text}</span>
          </div>

          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <input
              id="bookmark-note"
              value={note}
              placeholder="Note for this moment (optional), e.g. on the exam"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') markMoment()
              }}
            />
            <button onClick={markMoment} title="Bookmark this moment">
              ★ Bookmark
            </button>
          </div>
          {(state?.bookmarks.length ?? 0) > 0 && (
            <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
              {state!.bookmarks.map((b) => (
                <span key={b.id} className="chip" title={b.note || undefined}>
                  ★ {formatClock(b.atSec)}
                  {b.note ? ` · ${b.note}` : ''}
                </span>
              ))}
            </div>
          )}

          <h2 style={{ marginBottom: 8 }}>Live draft</h2>
          <div className="faint" style={{ marginBottom: 8 }}>
            A rough draft so you can follow along. It is replaced by a more accurate transcript when you stop.
          </div>
          <div className="live-feed" ref={feedRef}>
            {liveLines.length === 0 ? (
              <span className="faint">Waiting for speech…</span>
            ) : (
              liveLines.map((line) => (
                <div key={line.cursor} className={line.isFinal ? undefined : 'live-interim'}>
                  <span className="faint mono" style={{ marginRight: 8 }}>
                    {formatClock(line.start)}
                  </span>
                  {line.text}
                </div>
              ))
            )}
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {alertList}
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <strong>Record a lecture</strong>
          <div className="spacer" />
          <span className="faint">{klass.name}</span>
        </div>

        {openable.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label htmlFor="lecture-target">Record into</label>
            <select id="lecture-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">New lecture (today)</option>
              {openable.map((l) => (
                <option key={l.id} value={l.id}>
                  Continue: {l.title}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="row">
          <button className="record" onClick={() => onStart(target || null)} disabled={starting}>
            {starting ? 'Starting…' : '● Start recording'}
          </button>
          <button onClick={props.onNewLecture}>New lecture…</button>
          <button onClick={props.onImport} title="Import a recording from your phone, Zoom, Panopto…">
            Import recording…
          </button>
          <div className="spacer" />
        </div>
        <div className="faint" style={{ marginTop: 10 }}>
          Or drop audio and video files onto this page to import them.
        </div>

        {props.cloudLiveEnabled && (
          <div className="faint" style={{ marginTop: 10 }}>
            Audio is streamed to Deepgram for the live draft while you record.
          </div>
        )}
      </div>

      <MicCheck disabled={starting} />
    </>
  )
}
