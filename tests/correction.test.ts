import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CORRECTION_OPTIONS,
  editDistance,
  findCorrectionSuggestions,
  glossaryKeyterms,
  normalizePhrase,
  phoneticKey,
  similarityRatio
} from '@shared/correction'
import type { TranscriptSegment } from '@shared/types'

/** Build a segment from `[word, confidence]` pairs. */
function seg(id: string, words: [string, number][]): TranscriptSegment {
  return {
    id,
    start: 0,
    end: words.length,
    speaker: null,
    text: words.map(([w]) => w).join(' '),
    words: words.map(([word, confidence], i) => ({ word, start: i, end: i + 1, confidence }))
  }
}

describe('string metrics', () => {
  it('counts an adjacent transposition as one edit', () => {
    expect(editDistance('recieve', 'receive')).toBe(1)
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('', 'abc')).toBe(3)
  })

  it('normalizes case, punctuation and accents', () => {
    expect(normalizePhrase('Schrödinger’s!')).toBe('schrodingers')
    expect(normalizePhrase('  Navier   Stokes ')).toBe('navier stokes')
  })

  it('collapses commonly confused consonants after the first letter', () => {
    expect(phoneticKey('graph')).toBe(phoneticKey('graf'))
    expect(phoneticKey('Bayesian')).toBe(phoneticKey('basion'))
    expect(similarityRatio('abc', 'abc')).toBe(1)
  })

  it('keeps the initial consonant significant', () => {
    // A different first sound almost always means a different word, so these
    // must not collapse together.
    expect(phoneticKey('fat')).not.toBe(phoneticKey('cat'))
    expect(phoneticKey('bat')).not.toBe(phoneticKey('rat'))
  })
})

describe('findCorrectionSuggestions', () => {
  const glossary = [
    { term: 'eigenvalue' },
    { term: 'Bayesian' },
    { term: 'Nyquist' },
    { term: 'Dr. Chakrabarti' },
    { term: 'stochastic gradient descent' }
  ]

  it('flags a low-confidence misrecognition of a glossary term', () => {
    const segments = [seg('s1', [['the', 0.99], ['eigen', 0.4], ['value', 0.5], ['is', 0.98]])]
    const found = findCorrectionSuggestions(segments, glossary)
    const match = found.find((s) => s.suggested === 'eigenvalue')
    expect(match).toBeDefined()
    expect(match!.original).toBe('eigen value')
    expect(match!.status).toBe('pending')
  })

  it('never marks a suggestion as applied', () => {
    const segments = [seg('s1', [['basion', 0.3], ['prior', 0.9]])]
    const found = findCorrectionSuggestions(segments, glossary)
    expect(found.every((s) => s.status === 'pending')).toBe(true)
  })

  it('catches a one-word term split in two, with a single-word-only glossary', () => {
    // Regression: the span width was capped at the longest glossary term, so a
    // glossary of only one-word terms could never match "eigen value".
    const segments = [seg('s1', [['the', 0.98], ['eigen', 0.42], ['value', 0.44], ['of', 0.97]])]
    const found = findCorrectionSuggestions(segments, [{ term: 'eigenvalue' }, { term: 'Nyquist' }])
    const match = found.find((s) => s.suggested === 'eigenvalue')
    expect(match).toBeDefined()
    expect(match!.original).toBe('eigen value')
    expect(match!.wordCount).toBe(2)
  })

  it('leaves a correctly transcribed glossary term alone', () => {
    const segments = [seg('s1', [['the', 0.99], ['eigenvalue', 0.55], ['is', 0.98]])]
    const found = findCorrectionSuggestions(segments, glossary)
    expect(found.find((s) => s.original === 'eigenvalue')).toBeUndefined()
  })

  it('does not rewrite ordinary words into glossary terms', () => {
    // "the"/"they"/"that" must never become "Bayesian", "Nyquist" etc., even
    // when the model was unsure of them.
    const segments = [
      seg('s1', [
        ['the', 0.2],
        ['they', 0.3],
        ['that', 0.25],
        ['is', 0.3],
        ['set', 0.2],
        ['very', 0.3]
      ])
    ]
    expect(findCorrectionSuggestions(segments, glossary)).toEqual([])
  })

  it('requires a much stronger match when the model was confident', () => {
    const shaky = [seg('s1', [['basion', 0.35]])]
    const confident = [seg('s2', [['basion', 0.99]])]
    expect(findCorrectionSuggestions(shaky, glossary).length).toBeGreaterThan(0)
    expect(findCorrectionSuggestions(confident, glossary)).toEqual([])
  })

  it('only ever proposes verbatim glossary terms', () => {
    const segments = [
      seg('s1', [['nyquest', 0.4], ['rate', 0.9], ['and', 0.9], ['basean', 0.3], ['priors', 0.8]])
    ]
    const found = findCorrectionSuggestions(segments, glossary)
    expect(found.length).toBeGreaterThan(0)
    const terms = new Set(glossary.map((g) => g.term))
    for (const s of found) expect(terms.has(s.suggested)).toBe(true)
  })

  it('emits at most one suggestion per span of words', () => {
    const segments = [seg('s1', [['eigen', 0.3], ['value', 0.3], ['of', 0.9], ['nyquest', 0.3]])]
    const found = findCorrectionSuggestions(segments, glossary)
    const claimed = new Set<number>()
    for (const s of found) {
      for (let i = s.wordIndex; i < s.wordIndex + s.wordCount; i++) {
        expect(claimed.has(i)).toBe(false)
        claimed.add(i)
      }
    }
  })

  it('ignores glossary entries too short to match safely', () => {
    const segments = [seg('s1', [['pi', 0.2], ['or', 0.2], ['a', 0.2]])]
    expect(findCorrectionSuggestions(segments, [{ term: 'pi' }, { term: 'Q' }])).toEqual([])
  })

  it('returns nothing when the glossary is empty', () => {
    expect(findCorrectionSuggestions([seg('s1', [['anything', 0.1]])], [])).toEqual([])
  })

  it('respects the suggestion cap', () => {
    const words: [string, number][] = Array.from({ length: 200 }, () => ['eigen value', 0.2])
    const segments = [seg('s1', words)]
    const found = findCorrectionSuggestions(segments, glossary, {
      ...DEFAULT_CORRECTION_OPTIONS,
      maxSuggestions: 5
    })
    expect(found.length).toBeLessThanOrEqual(5)
  })
})

describe('glossaryKeyterms', () => {
  it('puts the most distinctive terms first and drops unusable ones', () => {
    const terms = glossaryKeyterms([{ term: 'a' }, { term: 'Bayesian' }, { term: 'stochastic gradient descent' }])
    expect(terms[0]).toBe('stochastic gradient descent')
    expect(terms).not.toContain('a')
  })

  it('honours the provider limit', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ term: `terminology${i}` }))
    expect(glossaryKeyterms(many, 100)).toHaveLength(100)
  })
})
