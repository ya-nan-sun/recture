/**
 * Pure helpers over `transcript.json`.
 *
 * The lecture view and every export are derived from these functions, so what
 * the student reads and what they export can never disagree — there is exactly
 * one place where a transcript becomes text.
 */

import type {
  CorrectionSuggestion,
  ExportOptions,
  TranscriptFile,
  TranscriptSegment,
  TranscriptWord
} from './types'
import { formatClock } from './naming'

export function emptyTranscript(base: {
  lectureId: string
  classId: string
  className: string
  lectureTitle: string
  recordedAt: string
}): TranscriptFile {
  const ts = new Date().toISOString()
  return {
    version: 1,
    ...base,
    durationSec: 0,
    source: { pass: 'final', provider: 'none', model: 'none', language: 'en' },
    createdAt: ts,
    updatedAt: ts,
    segments: [],
    suggestions: [],
    excludedAudioSegments: []
  }
}

/**
 * Apply one accepted suggestion to a segment's text and words.
 *
 * Replacement is positional (by word index), never a blind string search, so
 * accepting a suggestion can only ever change the exact span that was flagged
 * — a term appearing twice in a sentence will not be rewritten in both places.
 */
export function applySuggestionToSegment(
  segment: TranscriptSegment,
  suggestion: CorrectionSuggestion
): TranscriptSegment {
  const { wordIndex, wordCount, suggested } = suggestion
  if (wordIndex < 0 || wordIndex + wordCount > segment.words.length) return segment

  const replacedWords = segment.words.slice(wordIndex, wordIndex + wordCount)
  if (replacedWords.length === 0) return segment

  // Carry over trailing punctuation from the last replaced word so accepting
  // "Eigen value" -> "eigenvalue" doesn't eat the sentence's full stop.
  const last = replacedWords[replacedWords.length - 1]!
  const trailingPunct = /[.,;:!?)"'\]]+$/.exec(last.word)?.[0] ?? ''

  const merged = {
    word: suggested + trailingPunct,
    start: replacedWords[0]!.start,
    end: last.end,
    confidence: last.confidence
  }

  const words = [...segment.words.slice(0, wordIndex), merged, ...segment.words.slice(wordIndex + wordCount)]
  return { ...segment, words, text: words.map((w) => w.word).join(' ') }
}

/** A copy of the transcript with all accepted suggestions applied. */
export function materializeTranscript(transcript: TranscriptFile): TranscriptFile {
  const accepted = transcript.suggestions.filter((s) => s.status === 'accepted')
  if (accepted.length === 0) return transcript

  const bySegment = new Map<string, CorrectionSuggestion[]>()
  for (const s of accepted) {
    const list = bySegment.get(s.segmentId) ?? []
    list.push(s)
    bySegment.set(s.segmentId, list)
  }

  const segments = transcript.segments.map((segment) => {
    const list = bySegment.get(segment.id)
    if (!list) return segment
    // Apply right-to-left so earlier word indices stay valid as spans of
    // several words collapse into one.
    const ordered = [...list].sort((a, b) => b.wordIndex - a.wordIndex)
    return ordered.reduce(applySuggestionToSegment, segment)
  })

  return { ...transcript, segments }
}

// --- paragraphs ----------------------------------------------------------------

/** One segment's contribution to a paragraph, as shown. */
export interface ParagraphPiece {
  segmentId: string
  start: number
  text: string
  edited: boolean
}

export interface TranscriptParagraph {
  start: number
  end: number
  speaker: string | null
  text: string
  /** The segments this paragraph is made of, in order. */
  pieces: ParagraphPiece[]
}

export interface ParagraphOptions {
  /** A silence at least this long starts a new paragraph. */
  pauseSeconds?: number
}

export const DEFAULT_PAUSE_SECONDS = 2.5

const SENTENCE_END = /[.!?…]["'”’)\]]*$/

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim())
}

/**
 * Group segments into readable paragraphs.
 *
 * A paragraph ends where the lecture itself breaks: the speaker changes, or the
 * lecturer pauses. Past `paragraphSeconds` it ends at the next full stop rather
 * than mid-sentence, and past twice that it ends regardless, so a lecturer who
 * never seems to finish a sentence still doesn't produce a wall of text.
 */
export function toParagraphs(
  segments: TranscriptSegment[],
  paragraphSeconds: number,
  options: ParagraphOptions = {}
): TranscriptParagraph[] {
  const pause = options.pauseSeconds ?? DEFAULT_PAUSE_SECONDS
  const paragraphs: TranscriptParagraph[] = []
  let current: TranscriptParagraph | null = null

  for (const segment of segments) {
    const text = segment.text.trim()
    if (!text) continue
    const piece: ParagraphPiece = { segmentId: segment.id, start: segment.start, text, edited: Boolean(segment.edit) }

    let startNew = current === null
    if (current) {
      const length = segment.end - current.start
      startNew =
        current.speaker !== segment.speaker ||
        segment.start - current.end >= pause ||
        (length >= paragraphSeconds && endsSentence(current.text)) ||
        length >= paragraphSeconds * 2
    }

    if (startNew || !current) {
      current = { start: segment.start, end: segment.end, speaker: segment.speaker, text, pieces: [piece] }
      paragraphs.push(current)
    } else {
      current.text = `${current.text} ${text}`
      current.end = Math.max(current.end, segment.end)
      current.pieces.push(piece)
    }
  }
  return paragraphs
}

// --- fillers ---------------------------------------------------------------------

/** Hesitation sounds, and nothing that is ever a real word in a lecture. */
const FILLERS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'hmm', 'hm', 'mm', 'mmm'])

function splitToken(token: string): { core: string; trail: string } {
  const match = /^[^\p{L}\p{N}]*(.*?)([^\p{L}\p{N}]*)$/u.exec(token)
  return { core: match?.[1] ?? token, trail: match?.[2] ?? '' }
}

function isFillerCore(core: string): boolean {
  if (!FILLERS.has(core.toLowerCase())) return false
  // "UM" in capitals is an acronym (a university, a unit), not a hesitation.
  return !(core.length > 1 && core === core.toUpperCase())
}

function capitalizeFirstLetter(word: string): string {
  return word.replace(/\p{L}/u, (letter) => letter.toUpperCase())
}

/**
 * Remove hesitation sounds — "um", "uh", "erm" — for a cleaner read, fixing up
 * the punctuation and capitals around them.
 *
 * Deliberately conservative: words that are only sometimes filler ("like",
 * "you know", "so") are never touched, because removing them can change what
 * the lecturer meant.
 */
export function removeFillers(text: string): string {
  const kept: string[] = []
  let capitalizeNext = false

  for (const token of text.split(/\s+/).filter(Boolean)) {
    const { core, trail } = splitToken(token)
    if (!isFillerCore(core)) {
      kept.push(capitalizeNext ? capitalizeFirstLetter(token) : token)
      capitalizeNext = false
      continue
    }

    const previous = kept.length > 0 ? kept[kept.length - 1]! : null
    const atSentenceStart = previous === null || endsSentence(previous)
    const terminal = /[.!?…]/.exec(trail)?.[0] ?? null

    if (terminal && previous !== null && !endsSentence(previous)) {
      // "that's it, um." → "that's it."
      kept[kept.length - 1] = previous.replace(/[,;:\-–—]+$/, '') + terminal
    } else if (previous !== null && previous.endsWith(',') && trail.startsWith(',')) {
      // "the, uh, matrix" → "the matrix"
      kept[kept.length - 1] = previous.slice(0, -1)
    }

    // "Um, so today…" → "So today…"
    if (atSentenceStart && /^\p{Lu}/u.test(core)) capitalizeNext = true
  }
  return kept.join(' ')
}

// --- speakers --------------------------------------------------------------------

export function speakerLabel(speaker: string | null, names?: Record<string, string>): string | null {
  if (!speaker) return null
  const name = names?.[speaker]?.trim()
  return name ? name : speaker
}

/** Distinct speaker labels, in the order they first speak. */
export function speakersIn(transcript: TranscriptFile): string[] {
  const seen = new Set<string>()
  for (const segment of transcript.segments) {
    if (segment.speaker && !seen.has(segment.speaker)) seen.add(segment.speaker)
  }
  return [...seen]
}

export const MAX_SPEAKER_NAME = 60

export function setSpeakerName(transcript: TranscriptFile, speaker: string, name: string, now = new Date()): TranscriptFile {
  if (!speakersIn(transcript).includes(speaker)) throw new Error('Nobody with that label speaks in this lecture.')
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_SPEAKER_NAME)
  const names = { ...(transcript.speakerNames ?? {}) }
  if (!clean || clean === speaker) delete names[speaker]
  else names[speaker] = clean

  const next: TranscriptFile = { ...transcript, updatedAt: now.toISOString() }
  if (Object.keys(names).length > 0) next.speakerNames = names
  else delete next.speakerNames
  return next
}

// --- reading and exporting -------------------------------------------------------

export type ReadingOptions = Pick<ExportOptions, 'applyAcceptedSuggestions' | 'paragraphSeconds' | 'removeFillers'>

/**
 * Paragraphs as the student reads and exports them: accepted corrections
 * applied, hesitations removed if asked, and speakers called by their names.
 */
export function readableParagraphs(transcript: TranscriptFile, options: ReadingOptions): TranscriptParagraph[] {
  const source = options.applyAcceptedSuggestions ? materializeTranscript(transcript) : transcript
  const segments = options.removeFillers
    ? source.segments.map((segment) => ({ ...segment, text: removeFillers(segment.text) }))
    : source.segments
  return toParagraphs(segments, options.paragraphSeconds).map((paragraph) => ({
    ...paragraph,
    speaker: speakerLabel(paragraph.speaker, transcript.speakerNames)
  }))
}

/** Plain text, used for the clipboard. */
export function toPlainText(transcript: TranscriptFile, options: ExportOptions): string {
  return readableParagraphs(transcript, options)
    .map((p) => {
      const prefix: string[] = []
      if (options.includeTimestamps) prefix.push(`[${formatClock(p.start)}]`)
      if (p.speaker) prefix.push(`${p.speaker}:`)
      return prefix.length > 0 ? `${prefix.join(' ')} ${p.text}` : p.text
    })
    .join('\n\n')
}

/** Sections for per-part clipboard copy of very long transcripts. */
export function toSections(
  transcript: TranscriptFile,
  options: ExportOptions,
  sectionSeconds = 600
): { label: string; text: string }[] {
  const paragraphs = readableParagraphs(transcript, options)
  const sections: { label: string; text: string }[] = []

  let bucketStart = 0
  let buffer: string[] = []

  const flush = (end: number): void => {
    if (buffer.length === 0) return
    sections.push({
      label: `${formatClock(bucketStart)} – ${formatClock(end)}`,
      text: buffer.join('\n\n')
    })
    buffer = []
  }

  for (const p of paragraphs) {
    if (p.start >= bucketStart + sectionSeconds) {
      flush(p.start)
      bucketStart = Math.floor(p.start / sectionSeconds) * sectionSeconds
    }
    const prefix = options.includeTimestamps ? `[${formatClock(p.start)}] ` : ''
    const speaker = p.speaker ? `${p.speaker}: ` : ''
    buffer.push(`${prefix}${speaker}${p.text}`)
  }
  flush(paragraphs.length > 0 ? paragraphs[paragraphs.length - 1]!.end : bucketStart)
  return sections
}

/** What search indexes: the text as the student sees it, corrections and edits included. */
export function searchableSegments(transcript: TranscriptFile): { id: string; start: number; text: string }[] {
  return materializeTranscript(transcript).segments.map((s) => ({ id: s.id, start: s.start, text: s.text.trim() }))
}

// --- editing -------------------------------------------------------------------

export const MAX_SEGMENT_TEXT = 5000

const normalizeSpace = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Word timings for hand-typed text, spread evenly across the segment. */
function spreadWords(text: string, start: number, end: number): TranscriptWord[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  const step = tokens.length > 0 ? Math.max(0, end - start) / tokens.length : 0
  return tokens.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step, confidence: 1 }))
}

function segmentIndex(transcript: TranscriptFile, segmentId: string): number {
  const index = transcript.segments.findIndex((s) => s.id === segmentId)
  if (index < 0) throw new Error('That part of the transcript no longer exists.')
  return index
}

/**
 * Replace a segment's text with what the student typed.
 *
 * The original words are kept on the segment so the edit can be undone, and
 * the segment's glossary suggestions are set aside with them: they point at
 * word positions in the original text, which no longer exist.
 */
export function editSegmentText(
  transcript: TranscriptFile,
  segmentId: string,
  text: string,
  now = new Date()
): TranscriptFile {
  const index = segmentIndex(transcript, segmentId)
  const cleaned = normalizeSpace(text)
  if (cleaned.length > MAX_SEGMENT_TEXT) {
    throw new Error(`That is too long for one passage (${MAX_SEGMENT_TEXT.toLocaleString()} characters at most).`)
  }

  const segment = transcript.segments[index]!
  const previous = segment.edit ?? {
    originalText: segment.text,
    originalWords: segment.words,
    originalSuggestions: transcript.suggestions.filter((s) => s.segmentId === segmentId),
    editedAt: ''
  }
  // Typing the original wording back is the same as restoring it.
  if (cleaned === normalizeSpace(previous.originalText)) return revertSegmentEdit(transcript, segmentId, now)

  const updated: TranscriptSegment = {
    ...segment,
    text: cleaned,
    words: spreadWords(cleaned, segment.start, segment.end),
    edit: { ...previous, editedAt: now.toISOString() }
  }
  return {
    ...transcript,
    updatedAt: now.toISOString(),
    segments: transcript.segments.map((s, i) => (i === index ? updated : s)),
    suggestions: transcript.suggestions.filter((s) => s.segmentId !== segmentId)
  }
}

/** Put a hand-edited segment back exactly as it was transcribed. */
export function revertSegmentEdit(transcript: TranscriptFile, segmentId: string, now = new Date()): TranscriptFile {
  const index = segmentIndex(transcript, segmentId)
  const segment = transcript.segments[index]!
  if (!segment.edit) return transcript

  const { edit, ...rest } = segment
  const restored: TranscriptSegment = { ...rest, text: edit.originalText, words: edit.originalWords }
  return {
    ...transcript,
    updatedAt: now.toISOString(),
    segments: transcript.segments.map((s, i) => (i === index ? restored : s)),
    suggestions: [...transcript.suggestions.filter((s) => s.segmentId !== segmentId), ...edit.originalSuggestions].sort(
      (a, b) => a.start - b.start
    )
  }
}

export function editedSegmentCount(transcript: TranscriptFile): number {
  return transcript.segments.filter((s) => s.edit).length
}

export function transcriptWordCount(transcript: TranscriptFile): number {
  return transcript.segments.reduce((n, s) => n + s.words.length, 0)
}

export function pendingSuggestionCount(transcript: TranscriptFile): number {
  return transcript.suggestions.filter((s) => s.status === 'pending').length
}
