/**
 * Pure helpers over `transcript.json`.
 *
 * Every export format is derived from these functions, so Markdown, PDF and
 * clipboard output can never drift apart — there is exactly one place where a
 * transcript becomes text.
 */

import type { CorrectionSuggestion, ExportOptions, TranscriptFile, TranscriptSegment } from './types'
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

export interface TranscriptParagraph {
  start: number
  end: number
  speaker: string | null
  text: string
}

/**
 * Group segments into readable paragraphs. Starts a new paragraph when the
 * speaker changes or the running paragraph exceeds `paragraphSeconds`, so a
 * 90-minute lecture doesn't export as one wall of text.
 */
export function toParagraphs(segments: TranscriptSegment[], paragraphSeconds: number): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = []
  let current: TranscriptParagraph | null = null

  for (const segment of segments) {
    const text = segment.text.trim()
    if (!text) continue

    const speakerChanged = current !== null && current.speaker !== segment.speaker
    const tooLong = current !== null && segment.end - current.start >= paragraphSeconds

    if (!current || speakerChanged || tooLong) {
      current = { start: segment.start, end: segment.end, speaker: segment.speaker, text }
      paragraphs.push(current)
    } else {
      current.text = `${current.text} ${text}`
      current.end = segment.end
    }
  }
  return paragraphs
}

/** Plain text, used for the clipboard and as the PDF/Markdown body source. */
export function toPlainText(transcript: TranscriptFile, options: ExportOptions): string {
  const source = options.applyAcceptedSuggestions ? materializeTranscript(transcript) : transcript
  return toParagraphs(source.segments, options.paragraphSeconds)
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
  const source = options.applyAcceptedSuggestions ? materializeTranscript(transcript) : transcript
  const paragraphs = toParagraphs(source.segments, options.paragraphSeconds)
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

export function transcriptWordCount(transcript: TranscriptFile): number {
  return transcript.segments.reduce((n, s) => n + s.words.length, 0)
}

export function pendingSuggestionCount(transcript: TranscriptFile): number {
  return transcript.suggestions.filter((s) => s.status === 'pending').length
}
