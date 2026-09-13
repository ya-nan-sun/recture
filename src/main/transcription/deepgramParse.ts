/**
 * Deepgram response shapes and the single parser both the live and batch paths
 * use, so a change in how words map to segments applies to both at once.
 */

import { randomUUID } from 'node:crypto'
import type { TranscriptSegment, TranscriptWord } from '@shared/types'

export interface DeepgramWord {
  word: string
  start: number
  end: number
  confidence: number
  punctuated_word?: string
  speaker?: number
}

export interface DeepgramAlternative {
  transcript: string
  confidence?: number
  words?: DeepgramWord[]
  paragraphs?: {
    transcript?: string
    paragraphs?: { sentences?: { text: string; start: number; end: number }[]; speaker?: number }[]
  }
}

export interface DeepgramUtterance {
  start: number
  end: number
  confidence: number
  transcript: string
  speaker?: number
  words?: DeepgramWord[]
}

export interface DeepgramResponse {
  metadata?: { duration?: number; model_info?: Record<string, { name?: string }> }
  results?: {
    channels?: { alternatives?: DeepgramAlternative[] }[]
    utterances?: DeepgramUtterance[]
  }
}

function toWord(w: DeepgramWord): TranscriptWord {
  return {
    // `punctuated_word` carries casing and punctuation; fall back to the raw
    // token when smart formatting is off.
    word: w.punctuated_word ?? w.word,
    start: w.start,
    end: w.end,
    confidence: typeof w.confidence === 'number' ? w.confidence : 1
  }
}

const speakerLabel = (speaker: number | undefined): string | null =>
  typeof speaker === 'number' ? `Speaker ${speaker + 1}` : null

/**
 * Group a flat word list into sentence-ish segments.
 *
 * Deepgram's `utterances` are preferred when present; this is the fallback.
 * Breaks on sentence-final punctuation, on a speaker change, or after a pause
 * long enough to read as a new thought.
 */
export function wordsToSegments(
  words: DeepgramWord[],
  opts: { maxSegmentSeconds?: number; pauseSeconds?: number } = {}
): TranscriptSegment[] {
  const maxSegmentSeconds = opts.maxSegmentSeconds ?? 20
  const pauseSeconds = opts.pauseSeconds ?? 1.2

  const segments: TranscriptSegment[] = []
  let current: TranscriptWord[] = []
  let currentSpeaker: number | undefined
  let segmentStart = 0

  const flush = (): void => {
    if (current.length === 0) return
    segments.push({
      id: randomUUID(),
      start: segmentStart,
      end: current[current.length - 1]!.end,
      speaker: speakerLabel(currentSpeaker),
      text: current.map((w) => w.word).join(' '),
      words: current
    })
    current = []
  }

  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!
    const word = toWord(raw)
    const prev = words[i - 1]

    const speakerChanged = current.length > 0 && raw.speaker !== currentSpeaker
    const longPause = prev !== undefined && raw.start - prev.end >= pauseSeconds
    const tooLong = current.length > 0 && word.end - segmentStart >= maxSegmentSeconds

    if (current.length > 0 && (speakerChanged || longPause || tooLong)) flush()
    if (current.length === 0) {
      segmentStart = word.start
      currentSpeaker = raw.speaker
    }
    current.push(word)

    if (/[.!?]["')\]]?$/.test(word.word) && word.end - segmentStart >= 2) flush()
  }
  flush()
  return segments
}

/** Turn a batch response into transcript segments. */
export function parseDeepgramResponse(response: DeepgramResponse): {
  segments: TranscriptSegment[]
  durationSec: number
} {
  const durationSec = response.metadata?.duration ?? 0
  const utterances = response.results?.utterances

  if (utterances && utterances.length > 0) {
    const segments = utterances
      .filter((u) => u.transcript.trim().length > 0)
      .map((u) => ({
        id: randomUUID(),
        start: u.start,
        end: u.end,
        speaker: speakerLabel(u.speaker),
        text: u.transcript.trim(),
        words: (u.words ?? []).map(toWord)
      }))
    if (segments.length > 0) return { segments, durationSec }
  }

  const alternative = response.results?.channels?.[0]?.alternatives?.[0]
  if (!alternative) return { segments: [], durationSec }

  if (alternative.words && alternative.words.length > 0) {
    return { segments: wordsToSegments(alternative.words), durationSec }
  }

  // Last resort: a bare transcript string with no timing at all.
  const text = alternative.transcript.trim()
  if (!text) return { segments: [], durationSec }
  return {
    segments: [
      {
        id: randomUUID(),
        start: 0,
        end: durationSec,
        speaker: null,
        text,
        words: text.split(/\s+/).map((word, i) => ({ word, start: i, end: i + 1, confidence: 1 }))
      }
    ],
    durationSec
  }
}

// --- live streaming messages ----------------------------------------------

export interface DeepgramLiveMessage {
  type?: string
  channel?: { alternatives?: DeepgramAlternative[] }
  is_final?: boolean
  speech_final?: boolean
  start?: number
  duration?: number
  error?: string
  reason?: string
}

export interface LiveResult {
  text: string
  start: number
  end: number
  isFinal: boolean
}

export function parseLiveMessage(message: DeepgramLiveMessage): LiveResult | null {
  if (message.type && message.type !== 'Results') return null
  const alternative = message.channel?.alternatives?.[0]
  if (!alternative) return null
  const text = alternative.transcript?.trim() ?? ''
  if (!text) return null
  const start = message.start ?? 0
  return {
    text,
    start,
    end: start + (message.duration ?? 0),
    isFinal: Boolean(message.is_final)
  }
}
