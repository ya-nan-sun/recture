import { describe, expect, it } from 'vitest'
import { withRetry } from '@main/transcription/retry'
import { PermanentTranscriptionError, TransientTranscriptionError } from '@main/transcription/types'
import { parseDeepgramResponse, parseLiveMessage, wordsToSegments } from '@main/transcription/deepgramParse'
import { transcriptToMarkdown } from '@main/export/markdown'
import { transcriptToPdf } from '@main/export/pdf'
import { DEFAULT_EXPORT_OPTIONS, type TranscriptFile } from '@shared/types'

const noSleep = { sleep: async () => undefined, random: () => 0.5 }

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        return 'ok'
      },
      { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100, ...noSleep }
    )
    expect(result).toBe('ok')
    expect(calls).toBe(1)
  })

  it('retries transient failures and eventually succeeds', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) throw new TransientTranscriptionError('network blip')
        return 'recovered'
      },
      { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 100, ...noSleep }
    )
    expect(result).toBe('recovered')
    expect(calls).toBe(3)
  })

  it('gives up after maxAttempts and rethrows the last error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new TransientTranscriptionError('still down')
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, ...noSleep }
      )
    ).rejects.toThrow('still down')
    expect(calls).toBe(3)
  })

  it('does not retry a permanent error', async () => {
    let calls = 0
    await expect(
      withRetry(
        async () => {
          calls++
          throw new PermanentTranscriptionError('bad api key')
        },
        { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, ...noSleep }
      )
    ).rejects.toThrow('bad api key')
    // Retrying a bad key just delays telling the student.
    expect(calls).toBe(1)
  })

  it('backs off exponentially and honours a server Retry-After', async () => {
    const delays: number[] = []
    await expect(
      withRetry(
        async (attempt) => {
          throw attempt === 2
            ? new TransientTranscriptionError('rate limited', 7777)
            : new TransientTranscriptionError('5xx')
        },
        {
          maxAttempts: 4,
          baseDelayMs: 1000,
          maxDelayMs: 60_000,
          sleep: async (ms) => {
            delays.push(ms)
          },
          random: () => 1 // full jitter at its maximum, so delays are exact
        }
      )
    ).rejects.toThrow()
    expect(delays[0]).toBe(1000)
    expect(delays[1]).toBe(7777) // server-specified wins over the curve
    expect(delays[2]).toBe(4000)
  })
})

describe('deepgram parsing', () => {
  it('prefers utterances and keeps speaker labels', () => {
    const { segments, durationSec } = parseDeepgramResponse({
      metadata: { duration: 12.5 },
      results: {
        utterances: [
          { start: 0, end: 3, confidence: 0.9, transcript: 'Good morning.', speaker: 0, words: [] },
          { start: 3, end: 6, confidence: 0.8, transcript: 'A question.', speaker: 1, words: [] }
        ]
      }
    })
    expect(durationSec).toBe(12.5)
    expect(segments).toHaveLength(2)
    expect(segments[0]!.speaker).toBe('Speaker 1')
    expect(segments[1]!.speaker).toBe('Speaker 2')
  })

  it('uses punctuated words when smart formatting is on', () => {
    const { segments } = parseDeepgramResponse({
      metadata: { duration: 2 },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'hello world',
                words: [
                  { word: 'hello', punctuated_word: 'Hello,', start: 0, end: 0.5, confidence: 0.99 },
                  { word: 'world', punctuated_word: 'world.', start: 0.5, end: 1, confidence: 0.98 }
                ]
              }
            ]
          }
        ]
      }
    })
    expect(segments[0]!.text).toBe('Hello, world.')
    expect(segments[0]!.words[0]!.confidence).toBe(0.99)
  })

  it('falls back to a bare transcript with no word timings', () => {
    const { segments } = parseDeepgramResponse({
      metadata: { duration: 4 },
      results: { channels: [{ alternatives: [{ transcript: 'no timings here' }] }] }
    })
    expect(segments).toHaveLength(1)
    expect(segments[0]!.text).toBe('no timings here')
    expect(segments[0]!.words).toHaveLength(3)
  })

  it('returns nothing for an empty response instead of throwing', () => {
    expect(parseDeepgramResponse({}).segments).toEqual([])
    expect(parseDeepgramResponse({ results: { channels: [] } }).segments).toEqual([])
  })

  it('splits a word stream on long pauses and speaker changes', () => {
    const segments = wordsToSegments([
      { word: 'one', start: 0, end: 0.4, confidence: 1, speaker: 0 },
      { word: 'two', start: 0.4, end: 0.8, confidence: 1, speaker: 0 },
      // 3s gap -> new segment
      { word: 'three', start: 3.8, end: 4.2, confidence: 1, speaker: 0 },
      // speaker change -> new segment
      { word: 'four', start: 4.2, end: 4.6, confidence: 1, speaker: 1 }
    ])
    expect(segments).toHaveLength(3)
    expect(segments[2]!.speaker).toBe('Speaker 2')
  })

  it('reads interim and final live results', () => {
    const interim = parseLiveMessage({
      type: 'Results',
      start: 1,
      duration: 0.5,
      is_final: false,
      channel: { alternatives: [{ transcript: 'partial' }] }
    })
    expect(interim).toEqual({ text: 'partial', start: 1, end: 1.5, isFinal: false })

    expect(parseLiveMessage({ type: 'Metadata' })).toBeNull()
    expect(parseLiveMessage({ type: 'Results', channel: { alternatives: [{ transcript: '   ' }] } })).toBeNull()
  })
})

// --- exports ---------------------------------------------------------------

function sample(over: Partial<TranscriptFile> = {}): TranscriptFile {
  return {
    version: 1,
    lectureId: 'l1',
    classId: 'c1',
    className: 'Signals & Systems',
    lectureTitle: 'Nyquist sampling',
    recordedAt: '2026-09-12T14:00:00.000Z',
    durationSec: 95,
    source: { pass: 'final', provider: 'whisper-local', model: 'medium.en', language: 'en' },
    createdAt: '2026-09-12T15:00:00.000Z',
    updatedAt: '2026-09-12T15:00:00.000Z',
    segments: [
      {
        id: 'a',
        start: 0,
        end: 4,
        speaker: 'Speaker 1',
        text: 'Today we cover the Nyquist rate — and “aliasing”.',
        words: [{ word: 'Today', start: 0, end: 1, confidence: 0.9 }]
      }
    ],
    suggestions: [],
    excludedAudioSegments: [],
    ...over
  }
}

describe('markdown export', () => {
  it('includes the class, lecture and date header', () => {
    const md = transcriptToMarkdown(sample(), DEFAULT_EXPORT_OPTIONS)
    expect(md).toContain('# Nyquist sampling')
    expect(md).toContain('**Signals & Systems**')
    expect(md).toContain('`[0:00]`')
  })

  it('warns loudly when audio was excluded', () => {
    const md = transcriptToMarkdown(
      sample({ excludedAudioSegments: [{ relPath: 'audio/segment-0003.wav', reason: 'checksum_mismatch' }] }),
      DEFAULT_EXPORT_OPTIONS
    )
    expect(md).toMatch(/failed integrity checks/)
  })

  it('marks a live draft as not final', () => {
    const md = transcriptToMarkdown(
      sample({ source: { pass: 'live-draft', provider: 'deepgram-live', model: 'nova-3', language: 'en' } }),
      DEFAULT_EXPORT_OPTIONS
    )
    expect(md).toMatch(/Live draft/i)
  })
})

describe('pdf export', () => {
  it('produces a valid PDF', async () => {
    const bytes = await transcriptToPdf(sample(), DEFAULT_EXPORT_OPTIONS)
    expect(bytes.length).toBeGreaterThan(800)
    expect(Buffer.from(bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-')
  })

  it('does not throw on characters outside the standard font encoding', async () => {
    // Smart quotes, em dashes, Greek and CJK all appear in real lectures.
    const tricky = sample({
      segments: [
        {
          id: 'a',
          start: 0,
          end: 3,
          speaker: null,
          text: 'σ → ∞ — “quoted” … 日本語 ✓',
          words: [{ word: 'σ', start: 0, end: 1, confidence: 0.5 }]
        }
      ]
    })
    const bytes = await transcriptToPdf(tricky, DEFAULT_EXPORT_OPTIONS)
    expect(bytes.length).toBeGreaterThan(800)
  })

  it('paginates a long transcript', async () => {
    const segments = Array.from({ length: 300 }, (_, i) => ({
      id: `s${i}`,
      start: i * 20,
      end: i * 20 + 19,
      speaker: null,
      text: `Paragraph ${i}. ${'Sampling theory and reconstruction. '.repeat(4)}`,
      words: [{ word: 'Paragraph', start: i * 20, end: i * 20 + 1, confidence: 0.9 }]
    }))
    const bytes = await transcriptToPdf(sample({ segments }), DEFAULT_EXPORT_OPTIONS)
    // Several pages' worth of content.
    expect(bytes.length).toBeGreaterThan(20_000)
  })
})
