import { describe, expect, it } from 'vitest'
import type { CorrectionSuggestion, TranscriptFile, TranscriptSegment } from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import {
  applySuggestionToSegment,
  materializeTranscript,
  toParagraphs,
  toPlainText,
  toSections
} from '@shared/transcript'
import { formatClock, lectureFolderName, sanitizeSegment, uniqueName } from '@shared/naming'

function words(list: string[], start = 0) {
  return list.map((word, i) => ({ word, start: start + i, end: start + i + 1, confidence: 0.9 }))
}

function segment(id: string, list: string[], start = 0, speaker: string | null = null): TranscriptSegment {
  return { id, start, end: start + list.length, speaker, text: list.join(' '), words: words(list, start) }
}

function transcript(segments: TranscriptSegment[], suggestions: CorrectionSuggestion[] = []): TranscriptFile {
  return {
    version: 1,
    lectureId: 'l1',
    classId: 'c1',
    className: 'Linear Algebra',
    lectureTitle: 'Week 3',
    recordedAt: '2026-09-12T14:00:00.000Z',
    durationSec: 120,
    source: { pass: 'final', provider: 'whisper-local', model: 'medium.en', language: 'en' },
    createdAt: '2026-09-12T15:00:00.000Z',
    updatedAt: '2026-09-12T15:00:00.000Z',
    segments,
    suggestions,
    excludedAudioSegments: []
  }
}

function suggestion(over: Partial<CorrectionSuggestion> = {}): CorrectionSuggestion {
  return {
    id: 's1',
    segmentId: 'a',
    wordIndex: 1,
    wordCount: 2,
    start: 1,
    end: 3,
    original: 'eigen value',
    suggested: 'eigenvalue',
    spanConfidence: 0.4,
    similarity: 0.9,
    reason: 'test',
    status: 'accepted',
    ...over
  }
}

describe('naming', () => {
  it('strips characters that are illegal in a path segment', () => {
    expect(sanitizeSegment('CS 4501: ML/AI <intro>')).toBe('CS 4501 ML AI intro')
  })

  it('avoids Windows reserved device names', () => {
    expect(sanitizeSegment('CON')).toBe('CON_')
    expect(sanitizeSegment('nul')).toBe('nul_')
  })

  it('drops trailing dots and spaces that Windows would silently strip', () => {
    expect(sanitizeSegment('Week 3...')).toBe('Week 3')
    expect(sanitizeSegment('Week 3   ')).toBe('Week 3')
  })

  it('falls back rather than producing an empty name', () => {
    expect(sanitizeSegment('///', 'Untitled')).toBe('Untitled')
  })

  it('uses the local calendar date, not UTC', () => {
    // 2026-09-12 23:30 local must not roll forward to the 13th.
    const local = new Date(2026, 8, 12, 23, 30)
    expect(lectureFolderName(local, 'Week 3')).toBe('2026-09-12 - Week 3')
  })

  it('de-duplicates colliding folder names', () => {
    const taken = new Set(['Week 3', 'Week 3 (2)'])
    expect(uniqueName('Week 3', (c) => taken.has(c))).toBe('Week 3 (3)')
  })

  it('formats clock times with and without hours', () => {
    expect(formatClock(65)).toBe('1:05')
    expect(formatClock(3903)).toBe('1:05:03')
    expect(formatClock(-5)).toBe('0:00')
  })
})

describe('applySuggestionToSegment', () => {
  it('replaces exactly the flagged span', () => {
    const result = applySuggestionToSegment(segment('a', ['the', 'eigen', 'value', 'is']), suggestion())
    expect(result.text).toBe('the eigenvalue is')
    expect(result.words).toHaveLength(3)
    expect(result.words[1]!.start).toBe(1)
    expect(result.words[1]!.end).toBe(3)
  })

  it('does not rewrite an identical phrase elsewhere in the segment', () => {
    // "eigen value" appears twice; only the flagged occurrence may change.
    const seg = segment('a', ['the', 'eigen', 'value', 'and', 'eigen', 'value'])
    const result = applySuggestionToSegment(seg, suggestion())
    expect(result.text).toBe('the eigenvalue and eigen value')
  })

  it('keeps trailing punctuation', () => {
    const seg = segment('a', ['the', 'eigen', 'value.', 'Next'])
    expect(applySuggestionToSegment(seg, suggestion()).text).toBe('the eigenvalue. Next')
  })

  it('ignores an out-of-range span rather than corrupting the segment', () => {
    const seg = segment('a', ['short'])
    expect(applySuggestionToSegment(seg, suggestion({ wordIndex: 5 }))).toBe(seg)
  })
})

describe('materializeTranscript', () => {
  it('applies only accepted suggestions', () => {
    const file = transcript(
      [segment('a', ['the', 'eigen', 'value', 'is'])],
      [
        suggestion({ id: 's1', status: 'accepted' }),
        suggestion({ id: 's2', status: 'pending', wordIndex: 3, wordCount: 1, suggested: 'IS' })
      ]
    )
    expect(materializeTranscript(file).segments[0]!.text).toBe('the eigenvalue is')
  })

  it('handles several accepted suggestions in one segment without shifting indices', () => {
    const file = transcript(
      [segment('a', ['eigen', 'value', 'and', 'nyquest', 'rate'])],
      [
        suggestion({ id: 's1', wordIndex: 0, wordCount: 2, suggested: 'eigenvalue', status: 'accepted' }),
        suggestion({ id: 's2', wordIndex: 3, wordCount: 1, suggested: 'Nyquist', status: 'accepted' })
      ]
    )
    expect(materializeTranscript(file).segments[0]!.text).toBe('eigenvalue and Nyquist rate')
  })

  it('leaves the original transcript untouched', () => {
    const file = transcript([segment('a', ['eigen', 'value'])], [suggestion({ wordIndex: 0 })])
    materializeTranscript(file)
    expect(file.segments[0]!.text).toBe('eigen value')
  })
})

describe('toParagraphs', () => {
  it('breaks on speaker change', () => {
    const paragraphs = toParagraphs(
      [segment('a', ['hello'], 0, 'Speaker 1'), segment('b', ['there'], 1, 'Speaker 2')],
      600
    )
    expect(paragraphs).toHaveLength(2)
  })

  it('breaks once a paragraph runs past the limit', () => {
    const segments = Array.from({ length: 10 }, (_, i) => segment(`s${i}`, ['word'], i * 10))
    expect(toParagraphs(segments, 30).length).toBeGreaterThan(1)
  })

  it('skips empty segments', () => {
    expect(toParagraphs([segment('a', [])], 30)).toEqual([])
  })
})

describe('text exports', () => {
  it('includes timestamps when asked and omits them when not', () => {
    const file = transcript([segment('a', ['hello', 'world'])])
    expect(toPlainText(file, DEFAULT_EXPORT_OPTIONS)).toContain('[0:00]')
    expect(toPlainText(file, { ...DEFAULT_EXPORT_OPTIONS, includeTimestamps: false })).toBe('hello world')
  })

  it('splits long transcripts into labelled sections', () => {
    const segments = Array.from({ length: 40 }, (_, i) => segment(`s${i}`, ['word'], i * 60))
    const sections = toSections(transcript(segments), DEFAULT_EXPORT_OPTIONS, 600)
    expect(sections.length).toBeGreaterThan(1)
    expect(sections[0]!.label).toMatch(/^0:00 – /)
  })

  it('reflects accepted corrections in exported text', () => {
    const file = transcript([segment('a', ['the', 'eigen', 'value'])], [suggestion()])
    expect(toPlainText(file, { ...DEFAULT_EXPORT_OPTIONS, includeTimestamps: false })).toBe('the eigenvalue')
    expect(
      toPlainText(file, { ...DEFAULT_EXPORT_OPTIONS, includeTimestamps: false, applyAcceptedSuggestions: false })
    ).toBe('the eigen value')
  })
})
