// @vitest-environment jsdom
/**
 * The record screen's warnings and the remembered microphone.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClassRecord, RecordingState } from '@shared/types'
import type { RecordingAlert } from '@shared/alerts'
import { RecordPanel, type RecordPanelProps } from '../src/renderer/src/components/RecordPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const klass: ClassRecord = {
  id: 'cls-1',
  name: 'Linear Algebra',
  dirPath: 'C:/library/Classes/Linear Algebra',
  instructor: null,
  color: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
}

const recordingState: RecordingState = {
  active: true,
  lectureId: 'lec-1',
  lectureTitle: 'Week 3',
  className: 'Linear Algebra',
  startedAt: new Date().toISOString(),
  elapsedSec: 0,
  segmentsWritten: 0,
  bytesWritten: 0,
  live: { kind: 'disabled' },
  paused: false,
  pausedMs: 0,
  pausedAt: null,
  offsetSec: 0,
  bookmarks: []
}

let container: HTMLDivElement
let root: Root
let settingsGet: ReturnType<typeof vi.fn>
let settingsUpdate: ReturnType<typeof vi.fn>

function props(overrides: Partial<RecordPanelProps> = {}): RecordPanelProps {
  return {
    klass,
    lectures: [],
    state: null,
    level: { peak: 0, rms: 0 },
    liveLines: [],
    starting: false,
    cloudLiveEnabled: false,
    alerts: [],
    onAlertAction: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onPause: vi.fn(),
    onResume: vi.fn(),
    onBookmark: vi.fn(),
    onNewLecture: vi.fn(),
    ...overrides
  }
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`No "${label}" button`)
  return found
}

beforeEach(() => {
  settingsGet = vi.fn(async () => ({ micDeviceId: 'usb-1' }))
  settingsUpdate = vi.fn(async (patch: object) => patch)
  ;(window as unknown as { recture: unknown }).recture = {
    settings: { get: settingsGet, update: settingsUpdate }
  }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'usb-1', label: 'USB microphone' },
        { kind: 'audioinput', deviceId: 'built-in', label: 'Laptop microphone' },
        { kind: 'videooutput', deviceId: 'cam', label: 'Camera' }
      ])
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('RecordPanel warnings', () => {
  it('warns before recording, with a button that goes to the fix', async () => {
    const onAlertAction = vi.fn()
    const alerts: RecordingAlert[] = [
      { id: 'final-no-key', tone: 'warn', message: 'No Deepgram API key is saved.', action: 'settings' }
    ]
    await act(async () => root.render(<RecordPanel {...props({ alerts, onAlertAction })} />))
    await settle()

    expect(container.querySelector('[data-alert="final-no-key"]')?.textContent).toContain('No Deepgram API key')
    await act(async () => button('Open Settings').click())
    expect(onAlertAction).toHaveBeenCalledWith('settings')
  })

  it('offers to reconnect a microphone that stopped, while recording', async () => {
    const onAlertAction = vi.fn()
    const alerts: RecordingAlert[] = [
      { id: 'mic-stalled', tone: 'danger', message: 'The microphone stopped sending audio.', action: 'reconnect' }
    ]
    await act(async () => root.render(<RecordPanel {...props({ state: recordingState, alerts, onAlertAction })} />))

    const banner = container.querySelector('[data-alert="mic-stalled"]')
    expect(banner?.getAttribute('role')).toBe('alert')
    await act(async () => button('Reconnect microphone').click())
    expect(onAlertAction).toHaveBeenCalledWith('reconnect')
  })

  it('shows nothing extra when there is nothing to warn about', async () => {
    await act(async () => root.render(<RecordPanel {...props()} />))
    await settle()
    expect(container.querySelector('[data-alert]')).toBeNull()
  })
})

describe('Mic check', () => {
  it('shows the microphone recordings will use', async () => {
    await act(async () => root.render(<RecordPanel {...props()} />))
    await settle()
    const select = container.querySelector<HTMLSelectElement>('#mic-device')
    expect(select?.value).toBe('usb-1')
    expect(container.textContent).toContain('Recordings use this microphone.')
  })

  it('remembers a newly chosen microphone for recording', async () => {
    // Regression: the choice only applied to the check, and recording used the default.
    await act(async () => root.render(<RecordPanel {...props()} />))
    await settle()
    const select = container.querySelector<HTMLSelectElement>('#mic-device')!
    await act(async () => {
      select.value = 'built-in'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(settingsUpdate).toHaveBeenCalledWith({ micDeviceId: 'built-in' })
    expect(select.value).toBe('built-in')
  })

  it('says when the saved microphone is not connected', async () => {
    settingsGet.mockResolvedValue({ micDeviceId: 'headset-9' })
    await act(async () => root.render(<RecordPanel {...props()} />))
    await settle()
    expect(container.textContent).toContain('isn’t connected')
    expect(container.textContent).toContain('Saved microphone (not connected)')
  })
})
