// @vitest-environment jsdom
/**
 * Reading a lecture: correcting passages, finding text, a clean reading mode,
 * bookmarks, speaker names, the outline, and opening at a searched moment.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Bookmark, LectureRecord, TranscriptFile, TranscriptionQueueSnapshot } from '@shared/types'
import { LectureView, type LectureFocus } from '../src/renderer/src/components/LectureView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const lecture: LectureRecord = {
  id: 'lec-1',
  classId: 'cls-1',
  title: 'Week 3',
  dirPath: 'C:/library/Classes/Linear Algebra/2026-09-12 - Week 3',
  recordedAt: '2026-09-12T14:00:00.000Z',
  durationSec: 60,
  status: 'complete',
  statusDetail: null,
  transcriptSource: 'stub · stub',
  transcriptPass: 'final',
  segmentCount: 0,
  corruptSegmentCount: 0,
  createdAt: '2026-09-12T14:00:00.000Z',
  updatedAt: '2026-09-12T14:00:00.000Z'
}

const transcript: TranscriptFile = {
  version: 1,
  lectureId: 'lec-1',
  classId: 'cls-1',
  className: 'Linear Algebra',
  lectureTitle: 'Week 3',
  recordedAt: '2026-09-12T14:00:00.000Z',
  durationSec: 60,
  source: { pass: 'final', provider: 'stub', model: 'stub', language: 'en' },
  createdAt: '2026-09-12T15:00:00.000Z',
  updatedAt: '2026-09-12T15:00:00.000Z',
  segments: [
    { id: 's1', start: 0, end: 4, speaker: 'Speaker 1', text: 'Um, the eigen value of this matrix.', words: [] },
    { id: 's2', start: 4, end: 7, speaker: 'Speaker 1', text: 'It decides stability.', words: [] },
    { id: 's3', start: 20, end: 24, speaker: 'Speaker 2', text: 'Any questions about the matrix?', words: [] }
  ],
  suggestions: [],
  excludedAudioSegments: []
}

const bookmark: Bookmark = { id: 'b1', atSec: 5, note: 'on the exam', createdAt: '2026-09-12T14:05:00.000Z' }

let container: HTMLDivElement
let root: Root
let editSegment: Mock<(lectureId: string, segmentId: string, text: string) => Promise<TranscriptFile>>
let setSpeakerName: Mock<(lectureId: string, speaker: string, name: string) => Promise<TranscriptFile>>
let updateBookmark: Mock<(lectureId: string, id: string, note: string) => Promise<Bookmark[]>>
let scrollIntoView: Mock<() => void>

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(props: { focus?: LectureFocus | null; queue?: TranscriptionQueueSnapshot } = {}): Promise<void> {
  await act(async () =>
    root.render(
      <LectureView
        lecture={lecture}
        classes={[]}
        progress={null}
        queue={props.queue ?? { running: null, waiting: [] }}
        focus={props.focus ?? null}
        onToast={() => undefined}
        onChanged={() => undefined}
        onRemoved={() => undefined}
      />
    )
  )
  await settle()
}

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`No "${label}" button`)
  return found
}

beforeEach(() => {
  editSegment = vi.fn(async (_lectureId: string, segmentId: string, text: string) => ({
    ...transcript,
    segments: transcript.segments.map((s) =>
      s.id === segmentId
        ? { ...s, text, edit: { originalText: s.text, originalWords: [], originalSuggestions: [], editedAt: 'now' } }
        : s
    )
  }))
  setSpeakerName = vi.fn(async (_lectureId: string, speaker: string, name: string) => ({
    ...transcript,
    speakerNames: { [speaker]: name }
  }))
  updateBookmark = vi.fn(async (_lectureId: string, _id: string, note: string) => [{ ...bookmark, note }])
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView

  ;(window as unknown as { recture: unknown }).recture = {
    transcript: {
      get: vi.fn(async () => transcript),
      audioUrl: vi.fn(async () => null),
      retry: vi.fn(),
      setSuggestion: vi.fn(),
      editSegment,
      revertSegment: vi.fn(),
      setSpeakerName
    },
    transcription: { cancel: vi.fn() },
    bookmarks: { list: vi.fn(async () => [bookmark]), update: updateBookmark, remove: vi.fn(async () => []), add: vi.fn() },
    lectures: { reveal: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), cancelImport: vi.fn() },
    exports: { markdown: vi.fn(), pdf: vi.fn(), clipboard: vi.fn(), copyText: vi.fn() }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('correcting the transcript', () => {
  it('corrects a passage in place: double-click, type, Enter', async () => {
    await render()
    await act(async () => {
      container.querySelector('[data-seg="s1"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    const textarea = container.querySelector('textarea')!
    expect(textarea.value).toBe('Um, the eigen value of this matrix.')
    await act(async () => setValue(textarea, 'Um, the eigenvalue of this matrix.'))
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await settle()

    expect(editSegment).toHaveBeenCalledWith('lec-1', 's1', 'Um, the eigenvalue of this matrix.')
    expect(container.querySelector('textarea')).toBeNull()
    const passage = container.querySelector('[data-seg="s1"]')!
    expect(passage.textContent).toContain('eigenvalue')
    expect(passage.className).toContain('edited')
  })

  it('cancels with Escape, saving nothing', async () => {
    await render()
    await act(async () => {
      container.querySelector('[data-seg="s2"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    const textarea = container.querySelector('textarea')!
    await act(async () => setValue(textarea, 'something else'))
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('textarea')).toBeNull()
    expect(editSegment).not.toHaveBeenCalled()
    expect(container.querySelector('[data-seg="s2"]')!.textContent).toContain('It decides stability.')
  })

  it('does not start a correction while the lecture is being transcribed again', async () => {
    await render({ queue: { running: { lectureId: 'lec-1', startedAt: '2026-09-13T10:00:00.000Z' }, waiting: [] } })
    await act(async () => {
      container.querySelector('[data-seg="s1"]')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(container.querySelector('textarea')).toBeNull()
  })
})

describe('finding text in the lecture', () => {
  it('highlights every match and steps through them', async () => {
    await render()
    await act(async () => button('Find').click())
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Find in this lecture"]')!
    await act(async () => setValue(input, 'matrix'))

    expect(container.querySelectorAll('mark.find')).toHaveLength(2)
    expect(container.querySelector('.find-count')?.textContent).toBe('1 of 2')
    expect(container.querySelector('mark.find.active')?.getAttribute('data-match-index')).toBe('0')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(container.querySelector('.find-count')?.textContent).toBe('2 of 2')
    expect(container.querySelector('mark.find.active')?.getAttribute('data-match-index')).toBe('1')
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('opens at the moment a search found, with the words highlighted', async () => {
    await render({ focus: { atSec: 20, segmentId: 's3', query: 'questions', nonce: 1 } })
    const passage = container.querySelector('[data-seg="s3"]')!
    expect(passage.className).toContain('flash')
    expect(passage.querySelector('mark')?.textContent).toBe('questions')
    expect(scrollIntoView).toHaveBeenCalled()
  })
})

describe('reading options', () => {
  it('hides “um” and “uh” when asked', async () => {
    await render()
    expect(container.querySelector('[data-seg="s1"]')!.textContent).toContain('Um, the eigen value')

    const checkbox = [...container.querySelectorAll('label.check')]
      .find((label) => label.textContent?.includes('Hide'))!
      .querySelector('input')!
    await act(async () => checkbox.click())
    expect(container.querySelector('[data-seg="s1"]')!.textContent).toContain('The eigen value of this matrix.')
  })

  it('outlines the lecture with its sections and bookmarks', async () => {
    await render()
    await act(async () => button('Outline').click())
    const entries = [...container.querySelectorAll('.outline-entry')].map((el) => el.textContent)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toContain('0:00')
    expect(entries[1]).toContain('★ on the exam')
  })
})

describe('bookmarks and speakers', () => {
  it('shows bookmarks and saves a changed note', async () => {
    await render()
    const note = container.querySelector<HTMLInputElement>('input[aria-label="Note for the bookmark at 0:05"]')!
    expect(note.value).toBe('on the exam')
    await act(async () => {
      setValue(note, 'final exam')
      note.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await settle()
    expect(updateBookmark).toHaveBeenCalledWith('lec-1', 'b1', 'final exam')
  })

  it('names a speaker and shows the name in the transcript', async () => {
    await render()
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Name for Speaker 1"]')!
    await act(async () => {
      setValue(field, 'Prof. Chen')
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await settle()
    expect(setSpeakerName).toHaveBeenCalledWith('lec-1', 'Speaker 1', 'Prof. Chen')
    expect(container.querySelector('.para-text .speaker')?.textContent).toBe('Prof. Chen: ')
  })
})
