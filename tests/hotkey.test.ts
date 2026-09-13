import { describe, expect, it } from 'vitest'
import { validateAccelerator } from '@main/hotkey'

describe('validateAccelerator', () => {
  it('accepts normal shortcuts', () => {
    for (const ok of ['CommandOrControl+Shift+R', 'Ctrl+Alt+F5', 'CmdOrCtrl+Space', 'Alt+Up']) {
      expect(validateAccelerator(ok), ok).toMatchObject({ valid: true })
    }
  })

  it('rejects the half-typed shortcut that started this', () => {
    // Saving on every keystroke persisted this, and Electron could not register it.
    const result = validateAccelerator('CommandOrControl+Shift+;')
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/not a key/)
  })

  it('rejects a shortcut with no modifier', () => {
    expect(validateAccelerator('R')).toMatchObject({ valid: false })
  })

  it('rejects a shortcut that is only modifiers', () => {
    expect(validateAccelerator('Control+Shift').reason).toMatch(/normal key/)
  })

  it('rejects empty and trailing-plus input', () => {
    expect(validateAccelerator('')).toMatchObject({ valid: false })
    expect(validateAccelerator('   ')).toMatchObject({ valid: false })
    expect(validateAccelerator('Ctrl+Shift+').reason).toMatch(/empty section/)
  })

  it('names the offending modifier', () => {
    expect(validateAccelerator('Ctrrl+R').reason).toMatch(/ctrrl/)
  })
})
