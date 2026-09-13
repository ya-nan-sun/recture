import { describe, expect, it } from 'vitest'
import type { TranscriptFile, TranscriptSegment } from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { editSegmentText } from '@shared/transcript'
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ORDER,
  buildCues,
  csvCell,
  isExportFormat,
  lecturesToCsv,
  lecturesToExportJson,
  lecturesToText,
  splitIntoCues,
  srtTimestamp,
  transcriptToCsv,
  transcriptToExportJson,
  transcriptToSrt,
  transcriptToText,
  transcriptToVtt,
  vttTimestamp,
  wrapCueText
} from '@shared/exportFormats'

const seg = (id: string, start: number, end: number, speaker: string | null, text: string): TranscriptSegment => ({
  id,
  start,
  end,
  speaker,
  text,
  words: []
})

function transcript(segments: TranscriptSegment[], extra: Partial<TranscriptFile> = {}): TranscriptFile {
  return {
    version: 1,
    lectureId: 'l1',
    classId: 'c1',
    className: 'Linear Algebra',
    lectureTitle: 'Week 3',
    recordedAt: '2026-09-12T12:00:00.000Z',
    durationSec: 65,
    source: { pass: 'final', provider: 'whisper-local', model: 'medium.en', language: 'en' },
    createdAt: '2026-09-12T13:00:00.000Z',
    updatedAt: '2026-09-12T13:00:00.000Z',
    segments,
    suggestions: [],
    excludedAudioSegments: [],
    ...extra
  }
}

const lecture = transcript(
  [
    seg('s1', 0, 2.5, 'Speaker 1', 'Welcome back.'),
    seg('s2', 2.5, 4, 'Speaker 1', 'Today: vectors.'),
    seg('s3', 4, 6, 'Speaker 2', 'Question?')
  ],
  { speakerNames: { 'Speaker 1': 'Prof. Chen' } }
)

const options = DEFAULT_EXPORT_OPTIONS

describe('export formats', () => {
  it('lists every format once, each with its own extension', () => {
    expect(EXPORT_FORMAT_ORDER).toHaveLength(8)
    expect(new Set(EXPORT_FORMAT_ORDER)).toEqual(new Set(Object.keys(EXPORT_FORMATS)))
    expect(new Set(EXPORT_FORMAT_ORDER.map((f) => EXPORT_FORMATS[f].extension)).size).toBe(8)
  })

  it('never merges subtitles for a whole class', () => {
    expect(EXPORT_FORMAT_ORDER.filter((f) => !EXPORT_FORMATS[f].combinable)).toEqual(['srt', 'vtt'])
  })

  it('recognises only known formats', () => {
    expect(isExportFormat('docx')).toBe(true)
    expect(isExportFormat('exe')).toBe(false)
    expect(isExportFormat('toString')).toBe(false)
    expect(isExportFormat(42)).toBe(false)
  })
})

describe('subtitle timing', () => {
  it('writes timestamps the way each format expects', () => {
    expect(srtTimestamp(3723.4567)).toBe('01:02:03,457')
    expect(vttTimestamp(3723.4567)).toBe('01:02:03.457')
    expect(srtTimestamp(59.9996)).toBe('00:01:00,000')
    expect(srtTimestamp(-1)).toBe('00:00:00,000')
    expect(vttTimestamp(Number.NaN)).toBe('00:00:00.000')
  })

  it('breaks a long caption over two lines near the middle', () => {
    expect(wrapCueText('Short line')).toBe('Short line')
    const wrapped = wrapCueText('The determinant of a matrix tells you whether it can be inverted at all')
    const lines = wrapped.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.length <= 42)).toBe(true)
    const unbreakable = 'x'.repeat(60)
    expect(wrapCueText(unbreakable)).toBe(unbreakable)
  })

  it('splits a long passage into readable captions that cover it exactly', () => {
    const text = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ')
    const cues = splitIntoCues(text, 10, 30)
    expect(cues.length).toBeGreaterThanOrEqual(3)
    expect(cues.every((cue) => cue.text.length <= 84)).toBe(true)
    expect(cues.every((cue) => cue.end - cue.start <= 7.2)).toBe(true)
    expect(cues[0]!.start).toBe(10)
    expect(cues[cues.length - 1]!.end).toBe(30)
    for (let i = 1; i < cues.length; i++) expect(cues[i]!.start).toBeCloseTo(cues[i - 1]!.end, 9)
    expect(cues.map((cue) => cue.text).join(' ')).toBe(text)
  })

  it('keeps a short passage as a single caption', () => {
    expect(splitIntoCues('Hello there.', 1, 3)).toEqual([{ start: 1, end: 3, text: 'Hello there.' }])
  })

  it('never lets captions overlap, and keeps each up long enough to read', () => {
    const cues = buildCues(transcript([seg('a', 0, 3, null, 'First.'), seg('b', 2, 2.1, null, 'Second.')]), options)
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [0, 3, 'First.'],
      [3, 3.5, 'Second.']
    ])
  })
})

describe('SRT', () => {
  it('numbers captions and names the speaker whenever it changes', () => {
    expect(transcriptToSrt(lecture, options)).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:02,500',
        'Prof. Chen: Welcome back.',
        '',
        '2',
        '00:00:02,500 --> 00:00:04,000',
        'Today: vectors.',
        '',
        '3',
        '00:00:04,000 --> 00:00:06,000',
        'Speaker 2: Question?',
        ''
      ].join('\n')
    )
  })

  it('keeps caption text from being read as a timing line', () => {
    expect(transcriptToSrt(transcript([seg('a', 0, 2, null, 'from a --> b')]), options)).toContain('from a -> b')
  })
})

describe('WebVTT', () => {
  it('writes a header and gives each caption its speaker', () => {
    expect(transcriptToVtt(lecture, options)).toBe(
      [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:02.500',
        '<v Prof. Chen>Welcome back.',
        '',
        '00:00:02.500 --> 00:00:04.000',
        '<v Prof. Chen>Today: vectors.',
        '',
        '00:00:04.000 --> 00:00:06.000',
        '<v Speaker 2>Question?',
        ''
      ].join('\n')
    )
  })

  it('escapes text that would otherwise be read as tags', () => {
    const vtt = transcriptToVtt(transcript([seg('a', 0, 2, 'Dr. <Evil>', 'If a < b & b > c')]), options)
    expect(vtt).toContain('<v Dr. &lt;Evil&gt;>If a &lt; b &amp; b &gt; c')
  })
})

describe('spreadsheet', () => {
  it('writes one row per passage, quoting only what needs it', () => {
    const csv = transcriptToCsv(
      transcript([seg('a', 0, 2.5, 'Speaker 1', 'Welcome back.'), seg('b', 65, 70, null, 'He said "hi", then left.')], {
        speakerNames: { 'Speaker 1': 'Prof. Chen' }
      }),
      options
    )
    expect(csv).toBe(
      '﻿Start,End,Start (seconds),Speaker,Text,Edited\r\n' +
        '0:00,0:02,0,Prof. Chen,Welcome back.,\r\n' +
        '1:05,1:10,65,,"He said ""hi"", then left.",\r\n'
    )
  })

  it('stops a spreadsheet from running transcript text as a formula', () => {
    expect(csvCell('=SUM(A1:A3)')).toBe("'=SUM(A1:A3)")
    expect(csvCell('+44 20 7946 0000')).toBe("'+44 20 7946 0000")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('-5 degrees overnight')).toBe('-5 degrees overnight')
    expect(csvCell(' padded ')).toBe('" padded "')
    expect(csvCell(3.5)).toBe('3.5')
    expect(csvCell(Number.NaN)).toBe('')
  })

  it('marks passages corrected by hand', () => {
    const edited = editSegmentText(lecture, 's3', 'Any questions?')
    expect(transcriptToCsv(edited, options).split('\r\n')[3]).toBe('0:04,0:06,4,Speaker 2,Any questions?,yes')
  })

  it('adds the lecture and date to each row for a whole class', () => {
    const csv = lecturesToCsv([{ transcript: lecture }, { transcript: { ...lecture, lectureTitle: 'Week 4' } }], options)
    const rows = csv.replace('﻿', '').trimEnd().split('\r\n')
    expect(rows[0]).toBe('Lecture,Date,Start,End,Start (seconds),Speaker,Text,Edited')
    expect(rows[1]).toBe('Week 3,2026-09-12,0:00,0:02,0,Prof. Chen,Welcome back.,')
    expect(rows).toHaveLength(7)
    expect(rows[4]!.startsWith('Week 4,')).toBe(true)
  })
})

describe('JSON', () => {
  it('describes the lecture, its speakers, bookmarks and passages', () => {
    const json = transcriptToExportJson(lecture, options, {
      bookmarks: [{ id: 'b', atSec: 3.14159, note: 'vectors', createdAt: '' }]
    })
    expect(json).toEqual({
      format: 'recture.lecture',
      version: 1,
      lecture: {
        id: 'l1',
        title: 'Week 3',
        className: 'Linear Algebra',
        recordedAt: '2026-09-12T12:00:00.000Z',
        durationSec: 65
      },
      source: { pass: 'final', provider: 'whisper-local', model: 'medium.en', language: 'en' },
      speakers: [
        { label: 'Speaker 1', name: 'Prof. Chen' },
        { label: 'Speaker 2', name: null }
      ],
      bookmarks: [{ atSec: 3.142, note: 'vectors' }],
      segments: [
        { start: 0, end: 2.5, speaker: 'Prof. Chen', text: 'Welcome back.', edited: false },
        { start: 2.5, end: 4, speaker: 'Prof. Chen', text: 'Today: vectors.', edited: false },
        { start: 4, end: 6, speaker: 'Speaker 2', text: 'Question?', edited: false }
      ]
    })
  })

  it('follows the export options', () => {
    const noisy = transcript([seg('a', 0, 2, null, 'Um, hello.')])
    const json = transcriptToExportJson(
      noisy,
      { ...options, removeFillers: true, includeBookmarks: false },
      { bookmarks: [{ id: 'b', atSec: 1, note: 'x', createdAt: '' }] }
    )
    expect(json.segments[0]!.text).toBe('Hello.')
    expect(json.bookmarks).toEqual([])
  })

  it('collects a whole class', () => {
    const json = lecturesToExportJson('Linear Algebra', [{ transcript: lecture }, { transcript: lecture }], options)
    expect(json.format).toBe('recture.class')
    expect(json.className).toBe('Linear Algebra')
    expect(json.lectures).toHaveLength(2)
  })
})

describe('plain text', () => {
  const bookmarks = [
    { id: '2', atSec: 5, note: '', createdAt: '' },
    { id: '1', atSec: 3, note: 'vectors', createdAt: '' }
  ]

  it('writes a header, the bookmarks, then the transcript', () => {
    const text = transcriptToText(lecture, options, { bookmarks })
    const lines = text.split('\n')
    expect(lines[0]).toBe('Week 3')
    expect(lines[1]).toMatch(/^Linear Algebra · .+ · 1:05$/)
    expect(lines[2]).toBe('Transcribed by whisper-local (medium.en)')
    expect(text).toContain('\nBookmarks\n  0:03  vectors\n  0:05  Bookmarked moment\n')
    expect(text).toContain('\n[0:00] Prof. Chen: Welcome back. Today: vectors.\n')
    expect(text.endsWith('[0:04] Speaker 2: Question?\n')).toBe(true)
  })

  it('leaves bookmarks and timestamps out when asked', () => {
    const text = transcriptToText(lecture, { ...options, includeBookmarks: false, includeTimestamps: false }, { bookmarks })
    expect(text).not.toContain('Bookmarks')
    expect(text).toContain('\nProf. Chen: Welcome back. Today: vectors.\n')
  })

  it('says when it is only a live draft', () => {
    const draft = { ...lecture, source: { ...lecture.source, pass: 'live-draft' as const } }
    expect(transcriptToText(draft, options)).toContain('LIVE DRAFT')
  })

  it('puts a whole class in one file, lecture after lecture', () => {
    const text = lecturesToText('Linear Algebra', [{ transcript: lecture }, { transcript: { ...lecture, lectureTitle: 'Week 4' } }], options)
    expect(text.startsWith('Linear Algebra\n==============\n2 lectures\n\nWeek 3\n')).toBe(true)
    expect(text.split('-'.repeat(60))).toHaveLength(2)
    expect(text).toContain('\nWeek 4\n')
  })
})
