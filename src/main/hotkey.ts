/**
 * The global shortcuts: start/stop recording, and bookmark the current moment.
 *
 * Registration can fail for reasons outside our control — another app already
 * owns the combination, or the string isn't a valid Electron accelerator. Those
 * failures used to go only to stderr, which meant Settings could display a
 * shortcut that did nothing at all. Everything here returns a status the UI can
 * show instead.
 */

import { globalShortcut } from 'electron'
import type { HotkeyStatus } from '@shared/types'

export type { HotkeyStatus }

const MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta'
])

/** Key names Electron accepts as the final segment of an accelerator. */
const NAMED_KEYS = new Set([
  'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock', 'backspace', 'delete', 'insert',
  'return', 'enter', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'escape',
  'esc', 'volumeup', 'volumedown', 'volumemute', 'medianexttrack', 'mediaprevioustrack',
  'mediastop', 'mediaplaypause', 'printscreen',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')
])

export interface AcceleratorCheck {
  valid: boolean
  reason: string
}

/**
 * Validate before handing the string to Electron: `globalShortcut.register`
 * throws on some malformed input rather than returning false.
 */
export function validateAccelerator(accelerator: string): AcceleratorCheck {
  const trimmed = (accelerator ?? '').trim()
  if (!trimmed) return { valid: false, reason: 'Enter a shortcut, for example CommandOrControl+Shift+R.' }

  const parts = trimmed.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length !== trimmed.split('+').length) {
    return { valid: false, reason: 'Shortcut has an empty section — check the + signs.' }
  }
  if (parts.length < 2) {
    return { valid: false, reason: 'Add at least one modifier, for example CommandOrControl+Shift+R.' }
  }

  const key = parts[parts.length - 1]!.toLowerCase()
  const modifiers = parts.slice(0, -1).map((p) => p.toLowerCase())

  for (const modifier of modifiers) {
    if (!MODIFIERS.has(modifier)) {
      return { valid: false, reason: `“${modifier}” is not a modifier key.` }
    }
  }
  if (MODIFIERS.has(key)) {
    return { valid: false, reason: 'Finish the shortcut with a normal key, such as R.' }
  }
  if (!NAMED_KEYS.has(key)) {
    return { valid: false, reason: `“${parts[parts.length - 1]}” is not a key this shortcut can use.` }
  }
  return { valid: true, reason: '' }
}

export type HotkeyName = 'record' | 'bookmark'

const LABELS: Record<HotkeyName, string> = { record: 'record', bookmark: 'bookmark' }

/**
 * Owns the app's global shortcuts. Each one is registered, replaced and
 * reported independently, so a bad bookmark shortcut can never knock out the
 * recording shortcut.
 */
export class HotkeyManager {
  private readonly registered = new Map<HotkeyName, string>()
  private readonly statuses = new Map<HotkeyName, HotkeyStatus>()

  constructor(private readonly handlers: Record<HotkeyName, () => void>) {}

  getStatus(name: HotkeyName = 'record'): HotkeyStatus {
    return this.statuses.get(name) ?? { accelerator: '', registered: false, detail: 'Not set.' }
  }

  /** Register `accelerator` for `name`, replacing whatever that shortcut had before. */
  apply(name: HotkeyName, accelerator: string): HotkeyStatus {
    this.unregister(name)

    const check = validateAccelerator(accelerator)
    if (!check.valid) return this.setStatus(name, { accelerator, registered: false, detail: check.reason })

    const wanted = accelerator.trim().toLowerCase()
    const clash = [...this.registered.entries()].find(
      ([other, value]) => other !== name && value.trim().toLowerCase() === wanted
    )
    if (clash) {
      return this.setStatus(name, {
        accelerator,
        registered: false,
        detail: `Already used by the ${LABELS[clash[0]]} shortcut. Pick a different combination.`
      })
    }

    try {
      if (globalShortcut.register(accelerator, this.handlers[name])) {
        this.registered.set(name, accelerator)
        return this.setStatus(name, { accelerator, registered: true, detail: 'Active — works from any app.' })
      }
      return this.setStatus(name, {
        accelerator,
        registered: false,
        detail: 'Another app is already using this shortcut. Try a different combination.'
      })
    } catch (err) {
      return this.setStatus(name, {
        accelerator,
        registered: false,
        detail: `Could not register: ${(err as Error).message}`
      })
    }
  }

  dispose(): void {
    for (const name of [...this.registered.keys()]) this.unregister(name)
  }

  private unregister(name: HotkeyName): void {
    const current = this.registered.get(name)
    if (!current) return
    try {
      globalShortcut.unregister(current)
    } catch {
      // already gone
    }
    this.registered.delete(name)
  }

  private setStatus(name: HotkeyName, status: HotkeyStatus): HotkeyStatus {
    this.statuses.set(name, status)
    return status
  }
}
