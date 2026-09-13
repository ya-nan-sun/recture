/**
 * Glossary-based correction *suggestions*.
 *
 * Design constraints, in priority order:
 *
 *  1. It can only ever propose a replacement that is verbatim a term already
 *     in the class glossary. There is no generative step, so it is structurally
 *     incapable of inventing a word or rewriting a sentence.
 *  2. Nothing is applied automatically. Every match is emitted as a pending
 *     suggestion for the student to accept or reject.
 *  3. It errs towards silence. A missed misrecognition costs the student one
 *     manual fix; a wrong "correction" silently changes what the professor
 *     said, which is far worse. Hence the guards below: common English words
 *     are protected by a much higher bar, very short spans are skipped, and a
 *     span that already matches a glossary term exactly is never touched.
 */

import type { CorrectionSuggestion, TranscriptSegment, TranscriptWord } from './types'

/**
 * Words that are almost certainly correct as transcribed. Replacing one of
 * these is how you get "the" -> "theta", so they need near-identity to be
 * flagged at all.
 */
const COMMON_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that', 'have', 'i', 'it', 'for', 'not', 'on', 'with',
  'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her',
  'she', 'or', 'an', 'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up',
  'out', 'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make', 'can', 'like', 'time',
  'no', 'just', 'him', 'know', 'take', 'into', 'your', 'good', 'some', 'could', 'them', 'see',
  'other', 'than', 'then', 'now', 'look', 'only', 'come', 'its', 'over', 'think', 'also', 'back',
  'after', 'use', 'two', 'how', 'our', 'work', 'first', 'well', 'way', 'even', 'new', 'want',
  'because', 'any', 'these', 'give', 'day', 'most', 'us', 'is', 'are', 'was', 'were', 'has', 'had',
  'been', 'being', 'does', 'did', 'here', 'more', 'very', 'much', 'where', 'why', 'again', 'set'
])

export function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFD')
    // Strip combining marks so "Schrödinger" and "Schrodinger" compare equal.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

export function normalizePhrase(phrase: string): string {
  return phrase
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean)
    .join(' ')
}

/**
 * Optimal string alignment distance (Levenshtein plus adjacent transposition).
 * Transpositions matter here because STT output is full of them.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prevPrev: number[] = []
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr: number[] = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2]! + 1)
      }
      curr[j] = value
    }
    prevPrev = prev
    prev = curr
    curr = new Array<number>(b.length + 1)
  }
  return prev[b.length]!
}

/** 1 = identical, 0 = nothing in common. */
export function similarityRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const longest = Math.max(a.length, b.length)
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest
}

/**
 * A deliberately crude phonetic key: collapse the consonant classes that
 * speech recognition most often confuses, drop non-initial vowels, and squash
 * runs. "Bayesian"/"basion" and "eigenvalue"/"igan value" collapse together,
 * which is exactly the failure mode we want to catch.
 */
export function phoneticKey(input: string): string {
  const s = normalizeToken(input)
  if (!s) return ''
  const head = s[0]!
  const mapped = s
    .replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck|q|kh/g, 'k')
    .replace(/sh|ch|j/g, 'x')
    .replace(/th/g, '0')
    .replace(/[wy]/g, '')
    .replace(/[aeiou]/g, 'a')
    .replace(/[bp]/g, 'b')
    .replace(/[dt]/g, 'd')
    .replace(/[gk]/g, 'k')
    .replace(/[sz]/g, 's')
    .replace(/[fv]/g, 'f')
    .replace(/[mn]/g, 'm')
    .replace(/(.)\1+/g, '$1')

  // Keep the first letter distinct: a wrong initial consonant almost always
  // means a genuinely different word.
  const tail = mapped.slice(1).replace(/a/g, '')
  return head + tail
}

export interface GlossaryCandidate {
  term: string
  note?: string | null
}

interface PreparedTerm {
  term: string
  normalized: string
  phonetic: string
  wordCount: number
}

function prepareTerms(glossary: GlossaryCandidate[]): PreparedTerm[] {
  const seen = new Set<string>()
  const prepared: PreparedTerm[] = []
  for (const entry of glossary) {
    const normalized = normalizePhrase(entry.term)
    // A one- or two-character term can match almost anything; skip it rather
    // than produce noise.
    if (normalized.replace(/\s/g, '').length < 3) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    prepared.push({
      term: entry.term.trim(),
      normalized,
      phonetic: normalized.split(' ').map(phoneticKey).join(''),
      wordCount: normalized.split(' ').length
    })
  }
  return prepared
}

export interface CorrectionOptions {
  /** Spans whose lowest word confidence is below this are eligible. */
  confidenceThreshold: number
  /** Minimum similarity for a suggestion to be raised at all. */
  similarityThreshold: number
  /** Above this, a span is flagged even if the model was confident. */
  strongSimilarity?: number
  /** Safety cap so a bad glossary can't bury the review panel. */
  maxSuggestions?: number
}

export const DEFAULT_CORRECTION_OPTIONS: CorrectionOptions = {
  confidenceThreshold: 0.85,
  similarityThreshold: 0.74,
  strongSimilarity: 0.9,
  maxSuggestions: 300
}

function spanText(words: TranscriptWord[], start: number, count: number): string {
  return words
    .slice(start, start + count)
    .map((w) => w.word)
    .join(' ')
}

/**
 * Scan a transcript for spans that look like misheard glossary terms.
 * Returns pending suggestions; it never mutates the transcript.
 */
export function findCorrectionSuggestions(
  segments: TranscriptSegment[],
  glossary: GlossaryCandidate[],
  options: CorrectionOptions = DEFAULT_CORRECTION_OPTIONS
): CorrectionSuggestion[] {
  const terms = prepareTerms(glossary)
  if (terms.length === 0) return []

  const strongSimilarity = options.strongSimilarity ?? 0.9
  const maxSuggestions = options.maxSuggestions ?? 300
  // Allow spans one word longer than the longest glossary term: a single-word
  // term is very often split in two by the recognizer ("eigenvalue" heard as
  // "eigen value"), which is the single most common thing this step must catch.
  const maxWords = Math.min(3, Math.max(...terms.map((t) => t.wordCount)) + 1)
  const exactTerms = new Set(terms.map((t) => t.normalized))

  const suggestions: CorrectionSuggestion[] = []

  for (const segment of segments) {
    const words = segment.words
    // Per-segment best match by starting index, so overlapping candidate spans
    // collapse to the single strongest suggestion.
    const bestByIndex = new Map<number, CorrectionSuggestion>()

    for (let i = 0; i < words.length; i++) {
      for (let count = 1; count <= maxWords && i + count <= words.length; count++) {
        const span = words.slice(i, i + count)
        const normalized = normalizePhrase(spanText(words, i, count))
        if (normalized.replace(/\s/g, '').length < 3) continue

        // Already exactly a glossary term: leave it alone.
        if (exactTerms.has(normalized)) continue

        const spanConfidence = Math.min(...span.map((w) => w.confidence))
        const spanPhonetic = normalized.split(' ').map(phoneticKey).join('')
        const isCommon = count === 1 && COMMON_WORDS.has(normalized)

        for (const term of terms) {
          if (term.wordCount !== count && Math.abs(term.wordCount - count) > 1) continue

          const textual = similarityRatio(normalized, term.normalized)
          const phonetic = term.phonetic && spanPhonetic ? similarityRatio(spanPhonetic, term.phonetic) : 0
          // Weight spelling over sound: a phonetic-only match is suggestive,
          // not sufficient.
          const similarity = Math.max(textual, textual * 0.5 + phonetic * 0.5)

          if (similarity >= 0.999) continue // identical after normalization

          let required = options.similarityThreshold
          // Guard 1: an ordinary English word needs near-identity to be touched.
          if (isCommon) required = Math.max(required, 0.93)
          // Guard 2: short spans have too few characters for the ratio to mean
          // much, so demand more of them.
          if (normalized.length <= 4) required = Math.max(required, 0.85)
          // Guard 3: if the model was confident, only a very strong match counts.
          if (spanConfidence >= options.confidenceThreshold) required = Math.max(required, strongSimilarity)

          if (similarity < required) continue

          const original = spanText(words, i, count)
          // Nothing to do if the only difference is capitalization or padding.
          if (original.trim() === term.term) continue

          const candidate: CorrectionSuggestion = {
            id: `${segment.id}:${i}:${count}:${term.normalized}`,
            segmentId: segment.id,
            wordIndex: i,
            wordCount: count,
            start: span[0]!.start,
            end: span[span.length - 1]!.end,
            original,
            suggested: term.term,
            spanConfidence,
            similarity,
            reason:
              spanConfidence < options.confidenceThreshold
                ? `Low confidence (${Math.round(spanConfidence * 100)}%) and close to the glossary term “${term.term}”.`
                : `Very close to the glossary term “${term.term}”.`,
            status: 'pending'
          }

          const existing = bestByIndex.get(i)
          if (!existing || candidate.similarity > existing.similarity) bestByIndex.set(i, candidate)
        }
      }
    }

    // Drop suggestions whose spans overlap a stronger one in this segment.
    const ordered = [...bestByIndex.values()].sort((a, b) => b.similarity - a.similarity)
    const claimed = new Set<number>()
    for (const s of ordered) {
      const indices = Array.from({ length: s.wordCount }, (_, k) => s.wordIndex + k)
      if (indices.some((idx) => claimed.has(idx))) continue
      indices.forEach((idx) => claimed.add(idx))
      suggestions.push(s)
    }
  }

  return suggestions
    .sort((a, b) => a.start - b.start)
    .slice(0, maxSuggestions)
}

/**
 * Terms to hand the STT provider as keyterm/vocabulary hints. Providers cap
 * this list, so the most distinctive (longest) terms go first.
 */
export function glossaryKeyterms(glossary: GlossaryCandidate[], limit = 100): string[] {
  return prepareTerms(glossary)
    .map((t) => t.term)
    .sort((a, b) => b.length - a.length)
    .slice(0, limit)
}
