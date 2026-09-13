// @vitest-environment jsdom
/**
 * Exporting a whole class: format, one file or a file each, and options.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { ExportClassDialog } from '../src/renderer/src/components/ExportDialogs'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

async function render(counts: { lectureCount: number; transcribedCount: number }, onExport = vi.fn()) {
  await act(async () =>
    root.render(
      <ExportClassDialog className="Linear Algebra" {...counts} onClose={vi.fn()} onExport={onExport} />
    )
  )
  return onExport
}

const radios = (): HTMLInputElement[] => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
const exportButton = (): HTMLButtonElement => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Export…')!
const checkbox = (label: string): HTMLInputElement =>
  [...container.querySelectorAll('label.check')].find((l) => l.textContent?.includes(label))!.querySelector('input')!

describe('ExportClassDialog', () => {
  it('exports the whole class as one Markdown file by default', async () => {
    const onExport = await render({ lectureCount: 4, transcribedCount: 4 })
    expect(container.textContent).toContain('All 4 lectures will be exported, oldest first.')
    await act(async () => exportButton().click())
    expect(onExport).toHaveBeenCalledWith({ format: 'markdown', layout: 'single', options: DEFAULT_EXPORT_OPTIONS })
  })

  it('always exports subtitles one file per lecture', async () => {
    const onExport = await render({ lectureCount: 2, transcribedCount: 2 })
    const format = container.querySelector<HTMLSelectElement>('#class-export-format')!
    await act(async () => {
      format.value = 'srt'
      format.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const [single, perLecture] = radios()
    expect(single!.disabled).toBe(true)
    expect(perLecture!.checked).toBe(true)
    expect(container.textContent).toContain('each lecture gets its own file')

    await act(async () => exportButton().click())
    expect(onExport).toHaveBeenCalledWith({ format: 'srt', layout: 'per-lecture', options: DEFAULT_EXPORT_OPTIONS })
  })

  it('passes on the chosen layout and options', async () => {
    const onExport = await render({ lectureCount: 2, transcribedCount: 2 })
    await act(async () => radios()[1]!.click())
    await act(async () => checkbox('Hide').click())
    await act(async () => checkbox('Timestamps').click())
    await act(async () => exportButton().click())
    expect(onExport).toHaveBeenCalledWith({
      format: 'markdown',
      layout: 'per-lecture',
      options: { ...DEFAULT_EXPORT_OPTIONS, removeFillers: true, includeTimestamps: false }
    })
  })

  it('says how many lectures will be left out for lack of a transcript', async () => {
    await render({ lectureCount: 5, transcribedCount: 3 })
    expect(container.textContent).toContain('3 of 5 lectures have a transcript and will be exported')
  })

  it('cannot export a class with no transcripts', async () => {
    const onExport = await render({ lectureCount: 2, transcribedCount: 0 })
    expect(container.textContent).toContain('None of the lectures in this class has a transcript yet.')
    expect(exportButton().disabled).toBe(true)
    expect(onExport).not.toHaveBeenCalled()
  })
})
