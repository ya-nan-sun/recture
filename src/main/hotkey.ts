/**
 * The global record shortcut.
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

export class HotkeyManager {
  private current: string | null = null
  private status: HotkeyStatus = { accelerator: '', registered: false, detail: 'Not set.' }

  constructor(private readonly onTrigger: () => void) {}

  getStatus(): HotkeyStatus {
    return this.status
  }

  /** Register `accelerator`, replacing whatever was registered before. */
  apply(accelerator: string): HotkeyStatus {
    const check = validateAccelerator(accelerator)
    if (!check.valid) {
      this.unregister()
      this.status = { accelerator, registered: false, detail: check.reason }
      return this.status
    }

    this.unregister()
    try {
      const ok = globalShortcut.register(accelerator, this.onTrigger)
      if (ok) {
        this.current = accelerator
        this.status = { accelerator, registered: true, detail: 'Active — works from any app.' }
      } else {
        this.status = {
          accelerator,
          registered: false,
          detail: 'Another app is already using this shortcut. Try a different combination.'
        }
      }
    } catch (err) {
      this.status = { accelerator, registered: false, detail: `Could not register: ${(err as Error).message}` }
    }
    return this.status
  }

  private unregister(): void {
    if (this.current) {
      try {
        globalShortcut.unregister(this.current)
      } catch {
        // already gone
      }
      this.current = null
    }
  }

  dispose(): void {
    this.unregister()
  }
}
