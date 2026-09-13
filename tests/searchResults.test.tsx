// @vitest-environment jsdom
/**
 * Search results: every moment a search matched, opening the lecture there,
 * and transcript text that is only ever shown as text.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LectureRecord, SearchHit } from '@shared/types'
import { SEARCH_MARK_END as END, SEARCH_MARK_START as START } from '@shared/types'
import { SearchResults } from '../src/renderer/src/components/SearchResults'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const lecture: LectureRecord = {
  id: 'lec-1',
  classId: 'cls-1',
  title: 'Week 3',
  dirPath: 'C:/library/Classes/Linear Algebra/2026-09-12 - Week 3',
  recordedAt: '2026-09-12T14:00:00.000Z',
  durationSec: 3000,
  status: 'complete',
  statusDetail: null,
  transcriptSource: 'whisper-local · medium.en',
  transcriptPass: 'final',
  segmentCount: 0,
  corruptSegmentCount: 0,
  createdAt: '2026-09-12T14:00:00.000Z',
  updatedAt: '2026-09-12T14:00:00.000Z'
}

const hits: SearchHit[] = [
  {
    lecture,
    snippet: `…the ${START}matrix${END}…`,
    matches: [
      { segmentId: 's1', startSec: 65, snippet: `the ${START}matrix${END} is square` },
      { segmentId: 's9', startSec: 1325, snippet: `<img src=x onerror="alert(1)"> ${START}matrix${END}` }
    ]
  }
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const classNames = { 'cls-1': 'Linear Algebra' }

describe('SearchResults', () => {
  it('lists each moment with its time, marking only the matched words', async () => {
    await act(async () => root.render(<SearchResults query="matrix" hits={hits} classNames={classNames} onOpen={vi.fn()} />))
    expect(container.textContent).toContain('Week 3')
    expect(container.textContent).toContain('Linear Algebra')
    const times = [...container.querySelectorAll('.search-moment-time')].map((el) => el.textContent)
    expect(times).toEqual(['1:05', '22:05'])
    const marks = [...container.querySelectorAll('mark')].map((el) => el.textContent)
    expect(marks).toEqual(['matrix', 'matrix'])
  })

  it('shows transcript text as text, never as markup', async () => {
    await act(async () => root.render(<SearchResults query="matrix" hits={hits} classNames={classNames} onOpen={vi.fn()} />))
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
  })

  it('opens the lecture at the chosen moment, or at the top from its title', async () => {
    const onOpen = vi.fn()
    await act(async () => root.render(<SearchResults query="matrix" hits={hits} classNames={classNames} onOpen={onOpen} />))

    const moments = container.querySelectorAll<HTMLButtonElement>('.search-moment')
    await act(async () => moments[1]!.click())
    expect(onOpen).toHaveBeenLastCalledWith({ lectureId: 'lec-1', atSec: 1325, segmentId: 's9' })

    await act(async () => container.querySelector<HTMLButtonElement>('.search-hit-title')!.click())
    expect(onOpen).toHaveBeenLastCalledWith({ lectureId: 'lec-1' })
  })

  it('says so when nothing matches, and shows nothing before a search', async () => {
    await act(async () => root.render(<SearchResults query="zzz" hits={[]} classNames={classNames} onOpen={vi.fn()} />))
    expect(container.textContent).toContain('No matches')

    await act(async () => root.render(<SearchResults query="  " hits={[]} classNames={classNames} onOpen={vi.fn()} />))
    expect(container.textContent).toBe('')
  })
})
