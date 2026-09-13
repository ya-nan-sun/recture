import { describe, expect, it } from 'vitest'
import type { Bookmark, TranscriptFile } from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { editSegmentText, setSpeakerName } from '@shared/transcript'
import { transcriptToMarkdown } from '@main/export/markdown'
import { transcriptToPdf } from '@main/export/pdf'

const transcript: TranscriptFile = {
  version: 1,
  lectureId: 'l1',
  classId: 'c1',
  className: 'Linear Algebra',
  lectureTitle: 'Week 3',
  recordedAt: '2026-09-12T14:00:00.000Z',
  durationSec: 70,
  source: { pass: 'final', provider: 'whisper-local', model: 'medium.en', language: 'en' },
  createdAt: '2026-09-12T15:00:00.000Z',
  updatedAt: '2026-09-12T15:00:00.000Z',
  segments: [
    { id: 'a', start: 0, end: 4, speaker: 'Speaker 1', text: 'Um, welcome to week three.', words: [] },
    { id: 'b', start: 62, end: 66, speaker: 'Speaker 1', text: 'The eigen value matters.', words: [] }
  ],
  suggestions: [],
  excludedAudioSegments: []
}

const bookmarks: Bookmark[] = [
  { id: '2', atSec: 62, note: 'on the exam', createdAt: '' },
  { id: '1', atSec: 5, note: '', createdAt: '' }
]

describe('Markdown export', () => {
  it('lists bookmarks in lecture order, with a placeholder for ones without a note', () => {
    const markdown = transcriptToMarkdown(transcript, DEFAULT_EXPORT_OPTIONS, { bookmarks })
    expect(markdown).toContain('## Bookmarks\n\n- `0:05` _Bookmarked moment_\n- `1:02` on the exam\n')
  })

  it('leaves bookmarks out when asked to, or when there are none', () => {
    expect(transcriptToMarkdown(transcript, { ...DEFAULT_EXPORT_OPTIONS, includeBookmarks: false }, { bookmarks })).not.toContain(
      '## Bookmarks'
    )
    expect(transcriptToMarkdown(transcript, DEFAULT_EXPORT_OPTIONS)).not.toContain('## Bookmarks')
  })

  it('uses speaker names and hand corrections', () => {
    const corrected = setSpeakerName(editSegmentText(transcript, 'b', 'The eigenvalue matters.'), 'Speaker 1', 'Prof. Chen')
    const markdown = transcriptToMarkdown(corrected, DEFAULT_EXPORT_OPTIONS)
    expect(markdown).toContain('**Prof. Chen:** The eigenvalue matters.')
    expect(markdown).not.toContain('Speaker 1')
  })

  it('can leave out hesitations for a clean copy', () => {
    expect(transcriptToMarkdown(transcript, DEFAULT_EXPORT_OPTIONS)).toContain('Um, welcome to week three.')
    expect(transcriptToMarkdown(transcript, { ...DEFAULT_EXPORT_OPTIONS, removeFillers: true })).toContain(
      '**Speaker 1:** Welcome to week three.'
    )
  })
})

describe('PDF export', () => {
  it('includes bookmarks and stays well-formed', async () => {
    const plain = await transcriptToPdf(transcript, DEFAULT_EXPORT_OPTIONS)
    const withBookmarks = await transcriptToPdf(transcript, DEFAULT_EXPORT_OPTIONS, { bookmarks })
    expect(Buffer.from(withBookmarks.subarray(0, 5)).toString('ascii')).toBe('%PDF-')
    expect(withBookmarks.length).toBeGreaterThan(plain.length)
  })

  it('exports named speakers, clean text and corrections without failing', async () => {
    const corrected = setSpeakerName(editSegmentText(transcript, 'b', 'The eigenvalue — matters.'), 'Speaker 1', 'Prof. Chén')
    const bytes = await transcriptToPdf(corrected, { ...DEFAULT_EXPORT_OPTIONS, removeFillers: true }, { bookmarks })
    expect(Buffer.from(bytes.subarray(0, 5)).toString('ascii')).toBe('%PDF-')
  })
})
