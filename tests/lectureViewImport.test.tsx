// @vitest-environment jsdom
/**
 * A lecture that is still being imported: its progress, and a way to stop it.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ImportProgress, LectureRecord } from '@shared/types'
import { LectureView } from '../src/renderer/src/components/LectureView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const importing: LectureRecord = {
  id: 'lec-9',
  classId: 'cls-1',
  title: 'Week 7 voice memo',
  dirPath: 'C:/library/Classes/Economics/2026-09-10 - Week 7 voice memo',
  recordedAt: '2026-09-10T09:00:00.000Z',
  durationSec: 0,
  status: 'importing',
  statusDetail: 'Importing Week 7 voice memo.m4a…',
  transcriptSource: null,
  transcriptPass: null,
  segmentCount: 0,
  corruptSegmentCount: 0,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z'
}

const progress: ImportProgress = {
  lectureId: 'lec-9',
  phase: 'importing',
  fraction: 0.4,
  processedSec: 75,
  message: 'Importing Week 7 voice memo.m4a…'
}

let container: HTMLDivElement
let root: Root
let cancelImport: Mock<(lectureId: string) => Promise<boolean>>
let onChanged: Mock<() => void>

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function render(lecture: LectureRecord, importProgress: ImportProgress | null): Promise<void> {
  await act(async () =>
    root.render(
      <LectureView
        lecture={lecture}
        classes={[]}
        progress={null}
        queue={{ running: null, waiting: [] }}
        importProgress={importProgress}
        onToast={() => undefined}
        onChanged={onChanged}
        onRemoved={() => undefined}
      />
    )
  )
  await settle()
}

beforeEach(() => {
  cancelImport = vi.fn(async (_lectureId: string) => true)
  onChanged = vi.fn<() => void>()
  ;(window as unknown as { recture: unknown }).recture = {
    transcript: { get: vi.fn(async () => null), audioUrl: vi.fn(async () => null), retry: vi.fn(), setSuggestion: vi.fn() },
    transcription: { cancel: vi.fn() },
    lectures: { reveal: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn(), cancelImport },
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

describe('a lecture being imported', () => {
  it('shows how far the import has got', async () => {
    await render(importing, progress)

    const card = container.querySelector('[data-testid="import-progress"]')
    expect(card?.textContent).toContain('Importing Week 7 voice memo.m4a…')
    expect(card?.textContent).toContain('1:15')
    expect(container.querySelector<HTMLDivElement>('.progress-fill')?.style.width).toBe('40%')
    // Said once, in the progress card, not repeated in a status banner.
    expect(container.textContent!.split('Importing Week 7 voice memo.m4a…').length - 1).toBe(1)
    expect(container.textContent).not.toContain('Retry transcription')
    expect(container.textContent).toContain('once the file is imported')
  })

  it('can be cancelled', async () => {
    await render(importing, progress)
    const cancel = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!
    await act(async () => cancel.click())
    expect(cancelImport).toHaveBeenCalledWith('lec-9')
    expect(onChanged).toHaveBeenCalled()
  })

  it('shows progress even before the first update arrives', async () => {
    await render(importing, null)
    expect(container.querySelector('[data-testid="import-progress"]')?.textContent).toContain('Importing Week 7 voice memo.m4a…')
  })
})

describe('a lecture kept as one audio file', () => {
  it('does not claim to have "0 segments"', async () => {
    await render({ ...importing, status: 'complete', statusDetail: null, durationSec: 3600, segmentCount: 0 }, null)
    expect(container.querySelector('.subtitle')?.textContent).not.toMatch(/segment/)
    expect(container.querySelector('[data-testid="import-progress"]')).toBeNull()
  })
})
