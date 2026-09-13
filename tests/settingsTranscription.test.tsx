// @vitest-environment jsdom
/**
 * Settings → Transcription: the final transcript is chosen with option
 * buttons, the Whisper model lives inside the on-device option, and the live
 * draft and segment length controls are unchanged.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppSettings } from '@shared/types'
import { SettingsView } from '../src/renderer/src/components/SettingsView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: AppSettings = {
  rootDir: 'C:/Users/me/Documents/Recture',
  segmentSeconds: 45,
  liveProvider: 'deepgram-live',
  batchProvider: 'whisper-local',
  deepgramLiveModel: 'nova-3',
  deepgramBatchModel: 'nova-3',
  whisperModel: 'medium.en',
  whisperComputeType: 'int8',
  language: 'en',
  recordHotkey: 'CommandOrControl+Shift+R',
  bookmarkHotkey: 'Alt+Shift+B',
  correctionConfidenceThreshold: 0.85,
  correctionSimilarityThreshold: 0.74,
  acknowledgedCloudNotice: false,
  micDeviceId: '',
  apiKeyReentryNotice: false,
  audioStorage: 'wav',
  theme: 'system',
  transcriptFontSize: 15,
  playbackRate: 1,
  setupComplete: true
}

let container: HTMLDivElement
let root: Root
let update: Mock<(patch: Partial<AppSettings>) => Promise<AppSettings>>

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const options = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')
]

beforeEach(async () => {
  let current = { ...settings }
  update = vi.fn(async (patch: Partial<AppSettings>) => {
    current = { ...current, ...patch }
    return current
  })
  ;(window as unknown as { recture: unknown }).recture = {
    settings: {
      get: vi.fn(async () => current),
      update,
      hasApiKey: vi.fn(async () => false),
      providers: vi.fn(async () => [
        { id: 'whisper-local', available: false, detail: 'faster-whisper is not installed.', sendsAudioOffDevice: false },
        { id: 'deepgram-batch', available: true, detail: 'Ready.', sendsAudioOffDevice: true }
      ]),
      diskEncryption: vi.fn(async () => ({ encrypted: true, detail: 'BitLocker is on.' })),
      hotkeyStatus: vi.fn(async () => ({ accelerator: 'Alt+Shift+B', registered: true, detail: '' })),
      setHotkey: vi.fn(),
      setApiKey: vi.fn(),
      chooseRoot: vi.fn()
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<SettingsView onToast={() => undefined} />))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Settings: final transcript', () => {
  it('offers the choice as buttons, with the current one selected and its readiness shown', () => {
    const [local, cloud] = options()
    expect(options()).toHaveLength(2)
    expect(container.querySelector('select#batch')).toBeNull()

    expect(local!.textContent).toContain('On this computer')
    expect(local!.getAttribute('aria-checked')).toBe('true')
    expect(local!.textContent).toContain('Unavailable')
    expect(local!.textContent).toContain('faster-whisper is not installed.')

    expect(cloud!.textContent).toContain('Deepgram')
    expect(cloud!.getAttribute('aria-checked')).toBe('false')
    expect(cloud!.textContent).toContain('Ready')
  })

  it('switches provider with one click, and does nothing when the current one is clicked', async () => {
    await act(async () => options()[0]!.click())
    expect(update).not.toHaveBeenCalled()

    await act(async () => options()[1]!.click())
    await settle()
    expect(update).toHaveBeenCalledWith({ batchProvider: 'deepgram-batch' })
    expect(options()[1]!.getAttribute('aria-checked')).toBe('true')
    expect(options()[0]!.getAttribute('aria-checked')).toBe('false')
  })

  it('keeps the Whisper model inside the on-device option', async () => {
    const model = container.querySelector<HTMLSelectElement>('#whisper-model')!
    const owner = model.closest('.provider-option')!
    expect(owner.textContent).toContain('On this computer')
    expect(owner.textContent).not.toContain('Deepgram')
    expect(model.value).toBe('medium.en')

    await act(async () => {
      model.value = 'small.en'
      model.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(update).toHaveBeenCalledWith({ whisperModel: 'small.en' })
    expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ batchProvider: expect.anything() }))
  })

  it('leaves the live draft and segment length controls as they were', () => {
    const live = container.querySelector<HTMLSelectElement>('select#live')!
    expect([...live.options].map((o) => o.value)).toEqual(['deepgram-live', 'none'])
    expect(live.value).toBe('deepgram-live')

    const segment = container.querySelector<HTMLInputElement>('input#segment')!
    expect(segment.type).toBe('number')
    expect(segment.value).toBe('45')
    expect(segment.closest('.provider-option')).toBeNull()
  })
})
