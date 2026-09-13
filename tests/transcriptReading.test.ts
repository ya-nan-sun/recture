import { describe, expect, it } from 'vitest'
import type { CorrectionSuggestion, TranscriptFile, TranscriptSegment } from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import {
  editSegmentText,
  editedSegmentCount,
  endsSentence,
  readableParagraphs,
  removeFillers,
  revertSegmentEdit,
  searchableSegments,
  setSpeakerName,
  speakerLabel,
  speakersIn,
  toParagraphs,
  toPlainText
} from '@shared/transcript'

function seg(id: string, text: string, start: number, end: number, speaker: string | null = null): TranscriptSegment {
  const words = text.split(' ').filter(Boolean)
  const step = (end - start) / Math.max(1, words.length)
  return {
    id,
    start,
    end,
    speaker,
    text,
    words: words.map((word, i) => ({ word, start: start + i * step, end: start + (i + 1) * step, confidence: 0.9 }))
  }
}

function file(segments: TranscriptSegment[], suggestions: CorrectionSuggestion[] = [], extra: Partial<TranscriptFile> = {}): TranscriptFile {
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
    excludedAudioSegments: [],
    ...extra
  }
}

function suggestionFor(segmentId: string, over: Partial<CorrectionSuggestion> = {}): CorrectionSuggestion {
  return {
    id: `s-${segmentId}`,
    segmentId,
    wordIndex: 1,
    wordCount: 2,
    start: 1,
    end: 3,
    original: 'eigen value',
    suggested: 'eigenvalue',
    spanConfidence: 0.4,
    similarity: 0.9,
    reason: 'sounds like a glossary term',
    status: 'pending',
    ...over
  }
}

const ids = (paragraphs: ReturnType<typeof toParagraphs>): string[][] => paragraphs.map((p) => p.pieces.map((x) => x.segmentId))

describe('paragraphs that follow the lecture', () => {
  it('starts a new paragraph when the lecturer pauses', () => {
    const paragraphs = toParagraphs(
      [seg('a', 'First point.', 0, 4), seg('b', 'Still on it', 4.5, 7), seg('c', 'After a pause', 10, 12)],
      60
    )
    expect(ids(paragraphs)).toEqual([['a', 'b'], ['c']])
  })

  it('keeps steady speech together until the paragraph gets long', () => {
    const paragraphs = toParagraphs([seg('a', 'One.', 0, 5), seg('b', 'Two.', 5.2, 10), seg('c', 'Three.', 10.1, 14)], 30)
    expect(ids(paragraphs)).toEqual([['a', 'b', 'c']])
  })

  it('past the limit, ends at a full stop rather than mid-sentence', () => {
    const paragraphs = toParagraphs(
      [
        seg('a', 'We define', 0, 10),
        seg('b', 'a vector space.', 10, 20),
        seg('c', 'Next we look', 20, 30),
        seg('d', 'at bases.', 30, 40)
      ],
      15
    )
    expect(ids(paragraphs)).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('breaks a sentence that never ends at twice the limit', () => {
    const segments = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => seg(id, 'and so on', i * 10, i * 10 + 10))
    expect(ids(toParagraphs(segments, 15))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f']
    ])
  })

  it('records each passage with its time, and whether it was edited', () => {
    const edited = { ...seg('b', 'fixed', 1, 2), edit: { originalText: 'fixd', originalWords: [], originalSuggestions: [], editedAt: 'x' } }
    const [paragraph] = toParagraphs([seg('a', 'hello', 0, 1), edited], 30)
    expect(paragraph!.pieces).toEqual([
      { segmentId: 'a', start: 0, text: 'hello', edited: false },
      { segmentId: 'b', start: 1, text: 'fixed', edited: true }
    ])
    expect(paragraph!.text).toBe('hello fixed')
  })

  it('knows where sentences end', () => {
    expect(endsSentence('Done.')).toBe(true)
    expect(endsSentence('Really?”')).toBe(true)
    expect(endsSentence('(see page 3.)')).toBe(true)
    expect(endsSentence('and then,')).toBe(false)
  })
})

describe('removeFillers', () => {
  it.each([
    ['Um, so today we start.', 'So today we start.'],
    ['the, uh, matrix', 'the matrix'],
    ['the uh matrix is uhh square', 'the matrix is square'],
    ["that's it, um.", "that's it."],
    ['I think, erm, that works', 'I think that works'],
    ['Uh, um, right.', 'Right.'],
    ['Done. Um, next topic.', 'Done. Next topic.']
  ])('%s → %s', (input, expected) => {
    expect(removeFillers(input)).toBe(expected)
  })

  it('never touches words that only sometimes mean nothing', () => {
    const text = 'So, like, you know, I mean the umbrella term is basically this.'
    expect(removeFillers(text)).toBe(text)
  })

  it('keeps acronyms and responses that carry meaning', () => {
    const text = 'The UM campus said uh-huh and mm-hmm.'
    expect(removeFillers(text)).toBe(text)
  })

  it('leaves nothing when a passage was only hesitation', () => {
    expect(removeFillers('Um. Uh.')).toBe('')
  })
})

describe('speakers', () => {
  const transcript = file([
    seg('a', 'Welcome back.', 0, 2, 'Speaker 1'),
    seg('b', 'Question?', 2, 3, 'Speaker 2'),
    seg('c', 'Good question.', 3, 5, 'Speaker 1')
  ])

  it('lists speakers in the order they first speak', () => {
    expect(speakersIn(transcript)).toEqual(['Speaker 1', 'Speaker 2'])
  })

  it('uses the name the student gave, and the label otherwise', () => {
    expect(speakerLabel('Speaker 1', { 'Speaker 1': 'Prof. Chen' })).toBe('Prof. Chen')
    expect(speakerLabel('Speaker 2', { 'Speaker 1': 'Prof. Chen' })).toBe('Speaker 2')
    expect(speakerLabel(null, {})).toBeNull()
  })

  it('names, renames and un-names a speaker', () => {
    const named = setSpeakerName(transcript, 'Speaker 1', '  Prof.   Chen ')
    expect(named.speakerNames).toEqual({ 'Speaker 1': 'Prof. Chen' })
    expect(setSpeakerName(named, 'Speaker 1', '').speakerNames).toBeUndefined()
    expect(setSpeakerName(named, 'Speaker 1', 'Speaker 1').speakerNames).toBeUndefined()
    expect(transcript.speakerNames).toBeUndefined()
  })

  it('refuses a speaker who is not in the lecture', () => {
    expect(() => setSpeakerName(transcript, 'Speaker 9', 'Someone')).toThrow(/Nobody/)
  })

  it('exports with names, still split by who was speaking', () => {
    const named = setSpeakerName(transcript, 'Speaker 1', 'Prof. Chen')
    expect(toPlainText(named, { ...DEFAULT_EXPORT_OPTIONS, includeTimestamps: false })).toBe(
      'Prof. Chen: Welcome back.\n\nSpeaker 2: Question?\n\nProf. Chen: Good question.'
    )
  })
})

describe('reading options', () => {
  it('hides fillers only when asked', () => {
    const transcript = file([seg('a', 'Um, the matrix is, uh, square.', 0, 4)])
    const verbatim = { ...DEFAULT_EXPORT_OPTIONS, includeTimestamps: false }
    expect(toPlainText(transcript, verbatim)).toBe('Um, the matrix is, uh, square.')
    expect(toPlainText(transcript, { ...verbatim, removeFillers: true })).toBe('The matrix is square.')
  })

  it('drops a passage that was nothing but hesitation from the clean reading', () => {
    const transcript = file([seg('a', 'Um.', 0, 1), seg('b', 'Right.', 1.2, 2)])
    const paragraphs = readableParagraphs(transcript, { ...DEFAULT_EXPORT_OPTIONS, removeFillers: true })
    expect(paragraphs.flatMap((p) => p.pieces.map((x) => x.segmentId))).toEqual(['b'])
  })
})

describe('correcting a passage by hand', () => {
  const now = new Date('2026-09-13T10:00:00.000Z')
  const original = file(
    [seg('a', 'the eigen value is', 0, 4), seg('b', 'of the matrix', 4, 6)],
    [suggestionFor('a'), suggestionFor('b', { id: 's-b', start: 4 })]
  )

  it('replaces the text and keeps what it said before', () => {
    const edited = editSegmentText(original, 'a', '  the  eigenvalue is ', now)
    const segment = edited.segments[0]!
    expect(segment.text).toBe('the eigenvalue is')
    expect(segment.edit).toEqual({
      originalText: 'the eigen value is',
      originalWords: original.segments[0]!.words,
      originalSuggestions: [original.suggestions[0]],
      editedAt: now.toISOString()
    })
    expect(edited.updatedAt).toBe(now.toISOString())
  })

  it('spreads word timings across the passage', () => {
    const segment = editSegmentText(original, 'a', 'one two three four', now).segments[0]!
    expect(segment.words.map((w) => [w.word, w.start, w.end])).toEqual([
      ['one', 0, 1],
      ['two', 1, 2],
      ['three', 2, 3],
      ['four', 3, 4]
    ])
  })

  it('sets aside suggestions for that passage only', () => {
    const edited = editSegmentText(original, 'a', 'the eigenvalue is', now)
    expect(edited.suggestions.map((s) => s.id)).toEqual(['s-b'])
  })

  it('keeps the very first wording through several edits', () => {
    const twice = editSegmentText(editSegmentText(original, 'a', 'first try', now), 'a', 'second try', now)
    expect(twice.segments[0]!.text).toBe('second try')
    expect(twice.segments[0]!.edit?.originalText).toBe('the eigen value is')
  })

  it('restores the original words and suggestions', () => {
    const restored = revertSegmentEdit(editSegmentText(original, 'a', 'something else', now), 'a', now)
    expect(restored.segments[0]).toEqual(original.segments[0])
    expect(restored.suggestions.map((s) => s.id)).toEqual(['s-a', 's-b'])
  })

  it('treats typing the original wording back as restoring it', () => {
    const edited = editSegmentText(original, 'a', 'something else', now)
    const back = editSegmentText(edited, 'a', 'the eigen value is', now)
    expect(back.segments[0]!.edit).toBeUndefined()
    expect(back.suggestions).toHaveLength(2)
  })

  it('leaves the transcript it was given untouched', () => {
    const snapshot = JSON.stringify(original)
    editSegmentText(original, 'a', 'changed', now)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  it('refuses a passage that is gone, or text far too long for one', () => {
    expect(() => editSegmentText(original, 'zzz', 'x', now)).toThrow(/no longer exists/)
    expect(() => editSegmentText(original, 'a', 'word '.repeat(2000), now)).toThrow(/too long/)
  })

  it('drops an emptied passage from the reading view', () => {
    const emptied = editSegmentText(original, 'a', '   ', now)
    const pieces = readableParagraphs(emptied, DEFAULT_EXPORT_OPTIONS).flatMap((p) => p.pieces)
    expect(pieces.map((p) => p.segmentId)).toEqual(['b'])
  })

  it('counts edited passages', () => {
    expect(editedSegmentCount(original)).toBe(0)
    expect(editedSegmentCount(editSegmentText(original, 'b', 'of a matrix', now))).toBe(1)
  })

  it('makes search index what the student sees', () => {
    const accepted = file([seg('a', 'the eigen value is', 0, 4)], [suggestionFor('a', { status: 'accepted' })])
    expect(searchableSegments(accepted)).toEqual([{ id: 'a', start: 0, text: 'the eigenvalue is' }])
    const edited = editSegmentText(original, 'b', 'of the covariance matrix', now)
    expect(searchableSegments(edited)[1]).toEqual({ id: 'b', start: 4, text: 'of the covariance matrix' })
  })
})
