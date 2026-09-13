import { useCallback, useEffect, useRef, useState } from 'react'
import type { LiveTranscriptUpdate, RecordingState, TranscriptionProgress } from '@shared/types'
import { startCapture, type MicCapture, type MicLevel } from '../audio/recorder'

export interface LiveLine {
  cursor: number
  text: string
  isFinal: boolean
  start: number
}

/**
 * Owns microphone capture for the window.
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
  const [starting, setStarting] = useState(false)
  const captureRef = useRef<MicCapture | null>(null)

  useEffect(() => {
    void window.lecturerec.recording.state().then(setState)

    const offState = window.lecturerec.events.onRecordingState(setState)
    const offError = window.lecturerec.events.onRecordingError((payload) => onError(payload.message))
    const offProgress = window.lecturerec.events.onTranscriptionProgress((p: TranscriptionProgress) => setProgress(p))
    const offLive = window.lecturerec.events.onLiveTranscript((update: LiveTranscriptUpdate) => {
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
      setProgress(null)

      let started = false
      try {
        const next = await window.lecturerec.recording.start(classId, lectureId)
        started = true
        setState(next)

        captureRef.current = await startCapture({
          onFrame: (pcm) => window.lecturerec.recording.sendAudio(pcm),
          onLevel: setLevel,
          onError: (err) => onError(err.message)
        })
      } catch (err) {
        // Never leave a half-open session behind.
        if (started) await window.lecturerec.recording.stop().catch(() => undefined)
        await stopCapture()
        onError(err instanceof Error ? err.message : String(err))
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
      const { lectureId } = await window.lecturerec.recording.stop()
      setState(await window.lecturerec.recording.state())
      return lectureId
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [onError, stopCapture])

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
    starting,
    isRecording: Boolean(state?.active),
    start,
    stop
  }
}
