import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Bookmark,
  LiveTranscriptUpdate,
  RecordingState,
  TranscriptionProgress,
  TranscriptionQueueSnapshot
} from '@shared/types'
import { openPreferredDevice } from '@shared/devices'
import { SilenceDetector, type SilenceState } from '@shared/silence'
import { listMicrophones, startCapture, type MicCapture, type MicLevel } from '../audio/recorder'

export interface LiveLine {
  cursor: number
  text: string
  isFinal: boolean
  start: number
}

const EMPTY_QUEUE: TranscriptionQueueSnapshot = { running: null, waiting: [] }
const SILENCE_OK: SilenceState = { kind: 'ok' }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const sameSilence = (a: SilenceState, b: SilenceState): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Owns microphone capture for the window, plus the recording and transcription
 * state the UI shows.
 *
 * The main process is started first and stopped last: if opening the mic
 * fails, the session it just created is torn down rather than left as a
 * zero-length lecture stuck in `recording`.
 */
export function useRecording(onError: (message: string) => void) {
  const [state, setState] = useState<RecordingState | null>(null)
  const [level, setLevel] = useState<MicLevel>({ peak: 0, rms: 0 })
  const [liveLines, setLiveLines] = useState<LiveLine[]>([])
  const [progress, setProgress] = useState<TranscriptionProgress | null>(null)
  const [queue, setQueue] = useState<TranscriptionQueueSnapshot>(EMPTY_QUEUE)
  const [starting, setStarting] = useState(false)
  const [silence, setSilence] = useState<SilenceState>(SILENCE_OK)
  const [micFellBack, setMicFellBack] = useState(false)
  const [sleptDuringRecording, setSleptDuringRecording] = useState(false)
  const captureRef = useRef<MicCapture | null>(null)
  const detectorRef = useRef<SilenceDetector | null>(null)
  /** The microphone stream may be dead (device lost, or the computer slept). */
  const captureStaleRef = useRef(false)

  useEffect(() => {
    void window.recture.recording.state().then(setState)
    void window.recture.transcription.queue().then(setQueue)

    const offState = window.recture.events.onRecordingState(setState)
    const offError = window.recture.events.onRecordingError((payload) => onError(payload.message))
    const offProgress = window.recture.events.onTranscriptionProgress((p: TranscriptionProgress) => setProgress(p))
    const offQueue = window.recture.events.onTranscriptionQueue(setQueue)
    const offPower = window.recture.events.onPowerNotice((notice) => {
      if (notice.kind !== 'resumed-after-sleep') return
      captureStaleRef.current = true
      setSleptDuringRecording(true)
    })
    const offLive = window.recture.events.onLiveTranscript((update: LiveTranscriptUpdate) => {
      setLiveLines((prev) => {
        const next = [...prev]
        const at = next.findIndex((l) => l.cursor === update.cursor)
        const line: LiveLine = {
          cursor: update.cursor,
          text: update.text,
          isFinal: update.isFinal,
          start: update.start
        }
        // Interim results replace the line at the same cursor; a final result
        // freezes it and the next cursor starts a new line.
        if (at >= 0) next[at] = line
        else next.push(line)
        return next.slice(-400)
      })
    })

    return () => {
      offState()
      offError()
      offProgress()
      offQueue()
      offPower()
      offLive()
    }
  }, [onError])

  const stopCapture = useCallback(async () => {
    const capture = captureRef.current
    captureRef.current = null
    setLevel({ peak: 0, rms: 0 })
    if (capture) await capture.stop().catch(() => undefined)
  }, [])

  /**
   * Open the microphone chosen in Mic check, or the system default if it has
   * gone missing, feeding audio to the main process and levels to the silence
   * detector.
   */
  const openCapture = useCallback(async (): Promise<MicCapture> => {
    // Created before opening, so a microphone that never delivers audio is
    // reported as stalled instead of never being noticed.
    const detector = new SilenceDetector(Date.now())
    detectorRef.current = detector

    const [settings, available] = await Promise.all([
      window.recture.settings.get(),
      listMicrophones().catch(() => [] as MediaDeviceInfo[])
    ])
    const opened = await openPreferredDevice(settings.micDeviceId, available, (deviceId) =>
      startCapture({
        deviceId,
        onFrame: (pcm) => window.recture.recording.sendAudio(pcm),
        onLevel: (next) => {
          setLevel(next)
          detector.observe(next.rms, Date.now())
        },
        onError: (err) => {
          captureStaleRef.current = true
          onError(err.message)
        }
      })
    )
    captureStaleRef.current = false
    setMicFellBack(opened.fellBack)
    return opened.handle
  }, [onError])

  const start = useCallback(
    async (classId: string, lectureId: string | null) => {
      if (captureRef.current || starting) return
      setStarting(true)
      setLiveLines([])
      setSleptDuringRecording(false)

      let started = false
      try {
        const next = await window.recture.recording.start(classId, lectureId)
        started = true
        setState(next)
        captureRef.current = await openCapture()
      } catch (err) {
        // Never leave a half-open session behind.
        if (started) await window.recture.recording.stop().catch(() => undefined)
        await stopCapture()
        detectorRef.current = null
        onError(messageOf(err))
      } finally {
        setStarting(false)
      }
    },
    [onError, openCapture, starting, stopCapture]
  )

  const stop = useCallback(async (): Promise<string | null> => {
    // Stop the microphone first so no frame arrives after the session closes.
    await stopCapture()
    detectorRef.current = null
    setSilence(SILENCE_OK)
    setMicFellBack(false)
    setSleptDuringRecording(false)
    try {
      const { lectureId } = await window.recture.recording.stop()
      setState(await window.recture.recording.state())
      return lectureId
    } catch (err) {
      onError(messageOf(err))
      return null
    }
  }, [onError, stopCapture])

  /** Close and reopen the microphone without interrupting the recording. */
  const reconnect = useCallback(async (): Promise<boolean> => {
    await stopCapture()
    try {
      captureRef.current = await openCapture()
      setSilence(SILENCE_OK)
      return true
    } catch (err) {
      onError(`Couldn't reopen the microphone: ${messageOf(err)}`)
      return false
    }
  }, [onError, openCapture, stopCapture])

  const pause = useCallback(async (): Promise<void> => {
    try {
      setState(await window.recture.recording.pause())
    } catch (err) {
      onError(messageOf(err))
    }
  }, [onError])

  const resume = useCallback(async (): Promise<void> => {
    try {
      // After a sleep or a lost device the old stream delivers nothing.
      if (captureStaleRef.current || !captureRef.current) await reconnect()
      setState(await window.recture.recording.resume())
      detectorRef.current?.reset(Date.now())
      setSilence(SILENCE_OK)
      setSleptDuringRecording(false)
    } catch (err) {
      onError(messageOf(err))
    }
  }, [onError, reconnect])

  const bookmark = useCallback(
    async (note = ''): Promise<Bookmark | null> => {
      try {
        return await window.recture.recording.bookmark(note)
      } catch (err) {
        onError(messageOf(err))
        return null
      }
    },
    [onError]
  )

  // Check for silence once a second while recording. Paused recordings are
  // meant to be quiet, and coming back from a pause starts the count over.
  const active = Boolean(state?.active)
  const paused = Boolean(state?.paused)
  useEffect(() => {
    if (!active || paused) {
      setSilence(SILENCE_OK)
      return
    }
    detectorRef.current?.reset(Date.now())
    const timer = setInterval(() => {
      const detector = detectorRef.current
      const next = detector ? detector.state(Date.now()) : SILENCE_OK
      setSilence((prev) => (sameSilence(prev, next) ? prev : next))
    }, 1000)
    return () => clearInterval(timer)
  }, [active, paused])

  useEffect(() => {
    return () => {
      void stopCapture()
    }
  }, [stopCapture])

  return {
    state,
    level,
    liveLines,
    progress,
    queue,
    starting,
    silence,
    micFellBack,
    sleptDuringRecording,
    isRecording: active,
    isPaused: paused,
    start,
    stop,
    pause,
    resume,
    reconnect,
    bookmark
  }
}
