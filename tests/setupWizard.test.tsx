// @vitest-environment jsdom
/**
 * First-run setup: choosing how lectures are transcribed, getting that setup
 * ready, and adding a first class — or putting it all off.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ClassRecord, ProviderAvailability } from '@shared/types'
import { SetupWizard } from '../src/renderer/src/components/SetupWizard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let update: Mock<(patch: object) => Promise<object>>
let providers: Mock<() => Promise<ProviderAvailability[]>>
let setApiKey: Mock<(provider: string, key: string) => Promise<boolean>>
let create: Mock<(input: { name: string }) => Promise<ClassRecord>>
let onDone: Mock<(created: ClassRecord | null) => void>

const created: ClassRecord = {
  id: 'cls-1',
  name: 'CS 4501 Machine Learning',
  dirPath: 'C:/Users/me/Documents/Recture/Classes/CS 4501 Machine Learning',
  instructor: null,
  color: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z'
}

function setValue(el: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`No "${label}" button`)
  return found
}

async function click(label: string): Promise<void> {
  await act(async () => button(label).click())
  await settle()
}

async function pick(setupLabel: string): Promise<void> {
  const option = [...container.querySelectorAll('label.setup-choice')].find((l) => l.textContent?.includes(setupLabel))!
  await act(async () => option.querySelector('input')!.click())
}

beforeEach(async () => {
  update = vi.fn(async (patch: object) => patch)
  providers = vi.fn(async () => [
    { id: 'whisper-local', available: false, detail: 'faster-whisper is not installed.', sendsAudioOffDevice: false }
  ])
  setApiKey = vi.fn(async () => true)
  create = vi.fn(async () => created)
  onDone = vi.fn()
  ;(window as unknown as { recture: unknown }).recture = {
    settings: {
      get: vi.fn(async () => ({
        rootDir: 'C:/Users/me/Documents/Recture',
        liveProvider: 'deepgram-live',
        batchProvider: 'whisper-local'
      })),
      hasApiKey: vi.fn(async () => false),
      providers,
      setApiKey,
      update,
      chooseRoot: vi.fn(async () => null)
    },
    classes: { create }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<SetupWizard onDone={onDone} />))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SetupWizard', () => {
  it('sets up free, private transcription and the first class', async () => {
    expect(container.textContent).toContain('Welcome to Recture')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Lectures folder"]')?.value).toBe(
      'C:/Users/me/Documents/Recture'
    )

    await click('Next')
    await pick('Free and private')
    await click('Next')

    expect(providers).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('faster-whisper is not installed.')
    expect(container.textContent).toContain('Not ready')
    expect(container.querySelector('input[aria-label="Deepgram API key"]')).toBeNull()
    await click('Check again')
    expect(providers).toHaveBeenCalledTimes(2)

    await click('Next')
    await act(async () => setValue(container.querySelector<HTMLInputElement>('#setup-class-name')!, 'CS 4501 Machine Learning'))
    await click('Finish')

    expect(update).toHaveBeenCalledWith({ liveProvider: 'none', batchProvider: 'whisper-local', setupComplete: true })
    expect(create).toHaveBeenCalledWith({ name: 'CS 4501 Machine Learning' })
    expect(onDone).toHaveBeenCalledWith(created)
  })

  it('asks for a Deepgram key when the chosen setup uses Deepgram', async () => {
    await click('Next')
    await pick('Fast')
    await click('Next')

    expect(providers).not.toHaveBeenCalled()
    const key = container.querySelector<HTMLInputElement>('input[aria-label="Deepgram API key"]')!
    await act(async () => setValue(key, ' dg-123 '))
    await click('Save')
    expect(setApiKey).toHaveBeenCalledWith('deepgram', 'dg-123')
    expect(container.textContent).toContain('Saved')
    expect(container.textContent).toContain('Everything this setup needs is in place.')
  })

  it('starts from the setup the settings already describe, and can finish without a class', async () => {
    await click('Next')
    const selected = container.querySelector('label.setup-choice.selected')
    expect(selected?.textContent).toContain('Free, with live text')

    await click('Next')
    await click('Next')
    expect(button('Finish').disabled).toBe(true)
    await click('Skip')

    expect(update).toHaveBeenCalledWith({ liveProvider: 'deepgram-live', batchProvider: 'whisper-local', setupComplete: true })
    expect(create).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('can be put off until later, without changing how transcription works', async () => {
    await click('Set up later')
    expect(update).toHaveBeenCalledWith({ setupComplete: true })
    expect(onDone).toHaveBeenCalledWith(null)
  })

  it('goes back without losing the choice', async () => {
    await click('Next')
    await pick('Everything')
    await click('Next')
    await click('Back')
    expect(container.querySelector('label.setup-choice.selected')?.textContent).toContain('Everything')
  })
})
