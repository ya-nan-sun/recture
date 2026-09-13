// @vitest-environment jsdom
/**
 * Regression tests for the lecture view flickering between its transcript and
 * "Loading…" after a transcription finished.
 *
 * The cause was a render loop. Transcription progress stays latched at
 * `done`/`failed`, the parent passed a fresh `onChanged` callback on every
 * render, and the completion effect depended on that callback. Each run
 * reloaded the transcript (showing "Loading…") and refreshed the parent, which
 * re-rendered with a new callback and ran the effect again — forever.
 */

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LectureRecord, TranscriptFile, TranscriptionProgress } from '@shared/types'
import { LectureView } from '../src/renderer/src/components/LectureView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const lecture: LectureRecord = {
  id: 'lec-1',
  classId: 'cls-1',
  title: 'Week 3',
  dirPath: 'C:/library/Classes/Linear Algebra/2026-09-12 - Week 3',
  recordedAt: '2026-09-12T14:00:00.000Z',
  durationSec: 60,
  status: 'needs_transcription',
  statusDetail: null,
  transcriptSource: null,
  transcriptPass: null,
  segmentCount: 2,
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
    {
      id: 's1',
      start: 0,
      end: 4,
      speaker: null,
      text: 'The eigenvalue of this matrix determines stability.',
      words: [{ word: 'The', start: 0, end: 1, confidence: 0.9 }]
    }
  ],
  suggestions: [],
  excludedAudioSegments: []
}

function progress(phase: TranscriptionProgress['phase']): TranscriptionProgress {
  return { lectureId: 'lec-1', phase, message: phase, progress: null }
}

let container: HTMLDivElement
let root: Root
let getTranscript: ReturnType<typeof vi.fn>
let setProgress: (next: TranscriptionProgress | null) => void = () => undefined

/**
 * Mirrors how App renders the view: a brand-new `onChanged` on every render,
 * whose effect is an async refresh that re-renders the parent.
 */
function Parent({ initial }: { initial: TranscriptionProgress | null }): ReactNode {
  const [, setRenders] = useState(0)
  const [current, setCurrent] = useState(initial)
  setProgress = setCurrent
  return (
    <LectureView
      lecture={lecture}
      classes={[]}
      progress={current}
      onToast={() => undefined}
      onChanged={() => {
        void Promise.resolve().then(() => setRenders((n) => n + 1))
      }}
      onRemoved={() => undefined}
    />
  )
}

/** Let async loads, refreshes and the re-renders they cause run to completion. */
async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

beforeEach(() => {
  getTranscript = vi.fn(async () => transcript)
  ;(window as unknown as { recture: unknown }).recture = {
    transcript: {
      get: getTranscript,
      audioUrl: vi.fn(async () => null),
      retry: vi.fn(),
      setSuggestion: vi.fn()
    },
    lectures: { reveal: vi.fn(), rename: vi.fn(), move: vi.fn(), remove: vi.fn() },
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

describe('LectureView reloading', () => {
  it('does not reload in a loop when opened after a pass already finished', async () => {
    await act(async () => root.render(<Parent initial={progress('failed')} />))
    await settle()

    // One load on mount. The latched `failed` event predates the view, so it
    // must not trigger anything further however often the parent re-renders.
    expect(getTranscript).toHaveBeenCalledTimes(1)
  })

  it('reloads exactly once when a pass finishes while the lecture is open', async () => {
    await act(async () => root.render(<Parent initial={progress('transcribing')} />))
    await settle()
    expect(getTranscript).toHaveBeenCalledTimes(1)

    await act(async () => setProgress(progress('failed')))
    await settle()
    expect(getTranscript).toHaveBeenCalledTimes(2)

    // And it stays put while progress remains latched.
    await settle()
    expect(getTranscript).toHaveBeenCalledTimes(2)
  })

  it('keeps the transcript on screen while it reloads in the background', async () => {
    await act(async () => root.render(<Parent initial={null} />))
    await settle()
    expect(container.textContent).toContain('eigenvalue')

    // Next load never resolves, so the view is caught mid-reload.
    getTranscript.mockImplementationOnce(() => new Promise(() => undefined))
    await act(async () => setProgress(progress('done')))
    await settle(3)

    expect(container.textContent).toContain('eigenvalue')
    expect(container.textContent).not.toContain('Loading…')
  })
})
