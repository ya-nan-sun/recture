import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Bookmark,
  LiveTranscriptUpdate,
  RecordingState,
  TranscriptionProgress,
  TranscriptionQueueSnapshot
} from '@shared/types'
import { startCapture, type MicCapture, type MicLevel } from '../audio/recorder'

export interface LiveLine {
  cursor: number
  text: string
  isFinal: boolean
  start: number
}

const EMPTY_QUEUE: TranscriptionQueueSnapshot = { running: null, waiting: [] }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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
  const captureRef = useRef<MicCapture | null>(null)

  useEffect(() => {
    void window.recture.recording.state().then(setState)
    void window.recture.transcription.queue().then(setQueue)

    const offState = window.recture.events.onRecordingState(setState)
    const offError = window.recture.events.onRecordingError((payload) => onError(payload.message))
    const offProgress = window.recture.events.onTranscriptionProgress((p: TranscriptionProgress) => setProgress(p))
    const offQueue = window.recture.events.onTranscriptionQueue(setQueue)
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
      offLive()
    }
  }, [onError])

  const stopCapture = useCallback(async () => {
    const capture = captureRef.current
    captureRef.current = null
    setLevel({ peak: 0, rms: 0 })
    if (capture) await capture.stop().catch(() => undefined)
  }, [])

  const start = useCallback(
    async (classId: string, lectureId: string | null) => {
      if (captureRef.current || starting) return
      setStarting(true)
      setLiveLines([])

      let started = false
      try {
        const next = await window.recture.recording.start(classId, lectureId)
        started = true
        setState(next)

        captureRef.current = await startCapture({
          onFrame: (pcm) => window.recture.recording.sendAudio(pcm),
          onLevel: setLevel,
          onError: (err) => onError(err.message)
        })
      } catch (err) {
        // Never leave a half-open session behind.
        if (started) await window.recture.recording.stop().catch(() => undefined)
        await stopCapture()
        onError(messageOf(err))
      } finally {
        setStarting(false)
      }
    },
    [onError, starting, stopCapture]
  )

  const stop = useCallback(async (): Promise<string | null> => {
    // Stop the microphone first so no frame arrives after the session closes.
    await stopCapture()
    try {
      const { lectureId } = await window.recture.recording.stop()
      setState(await window.recture.recording.state())
      return lectureId
    } catch (err) {
      onError(messageOf(err))
      return null
    }
  }, [onError, stopCapture])

  const pause = useCallback(async (): Promise<void> => {
    try {
      setState(await window.recture.recording.pause())
    } catch (err) {
      onError(messageOf(err))
    }
  }, [onError])

  const resume = useCallback(async (): Promise<void> => {
    try {
      setState(await window.recture.recording.resume())
    } catch (err) {
      onError(messageOf(err))
    }
  }, [onError])

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
    isRecording: Boolean(state?.active),
    isPaused: Boolean(state?.paused),
    start,
    stop,
    pause,
    resume,
    bookmark
  }
}
