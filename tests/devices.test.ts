import { describe, expect, it, vi } from 'vitest'
import { chooseCaptureDevice, isMissingDeviceError, openPreferredDevice } from '@shared/devices'

const mics = [
  { deviceId: 'usb-1', label: 'USB microphone' },
  { deviceId: 'built-in', label: 'Laptop microphone' }
]

const domError = (name: string): Error => Object.assign(new Error(name), { name })

describe('chooseCaptureDevice', () => {
  it('uses the system default when nothing was chosen', () => {
    expect(chooseCaptureDevice('', mics)).toEqual({ deviceId: undefined, fellBack: false })
    expect(chooseCaptureDevice(null, mics)).toEqual({ deviceId: undefined, fellBack: false })
    expect(chooseCaptureDevice('default', mics)).toEqual({ deviceId: undefined, fellBack: false })
  })

  it('records with the microphone picked in the mic check', () => {
    // Regression: recording ignored the mic check's choice and used the default.
    expect(chooseCaptureDevice('usb-1', mics)).toEqual({ deviceId: 'usb-1', fellBack: false })
  })

  it('falls back to the default, and says so, when that microphone is unplugged', () => {
    expect(chooseCaptureDevice('headset-9', mics)).toEqual({ deviceId: undefined, fellBack: true })
  })

  it('trusts the saved choice while devices cannot be listed yet', () => {
    expect(chooseCaptureDevice('usb-1', [])).toEqual({ deviceId: 'usb-1', fellBack: false })
    // Before permission is granted the browser lists devices without ids.
    const unlabelled = [{ deviceId: '', label: '' }]
    expect(chooseCaptureDevice('usb-1', unlabelled)).toEqual({ deviceId: 'usb-1', fellBack: false })
  })
})

describe('isMissingDeviceError', () => {
  it('recognises a device that is not there', () => {
    expect(isMissingDeviceError(domError('OverconstrainedError'))).toBe(true)
    expect(isMissingDeviceError(domError('NotFoundError'))).toBe(true)
  })

  it('does not treat denied permission as a missing device', () => {
    expect(isMissingDeviceError(domError('NotAllowedError'))).toBe(false)
    expect(isMissingDeviceError(new Error('boom'))).toBe(false)
    expect(isMissingDeviceError(null)).toBe(false)
  })
})

describe('openPreferredDevice', () => {
  it('opens the saved microphone', async () => {
    const open = vi.fn(async (id: string | undefined) => `stream:${id}`)
    await expect(openPreferredDevice('usb-1', mics, open)).resolves.toEqual({ handle: 'stream:usb-1', fellBack: false })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('goes straight to the default when the saved microphone is not listed', async () => {
    const open = vi.fn(async (id: string | undefined) => `stream:${id}`)
    await expect(openPreferredDevice('headset-9', mics, open)).resolves.toEqual({
      handle: 'stream:undefined',
      fellBack: true
    })
    expect(open).toHaveBeenCalledWith(undefined)
  })

  it('still starts recording when the saved microphone fails to open', async () => {
    // Listed, but unplugged a moment ago.
    const open = vi.fn(async (id: string | undefined) => {
      if (id) throw domError('OverconstrainedError')
      return 'stream:default'
    })
    await expect(openPreferredDevice('usb-1', mics, open)).resolves.toEqual({ handle: 'stream:default', fellBack: true })
    expect(open.mock.calls).toEqual([['usb-1'], [undefined]])
  })

  it('does not paper over denied microphone permission', async () => {
    const open = vi.fn(async () => {
      throw domError('NotAllowedError')
    })
    await expect(openPreferredDevice('usb-1', mics, open)).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(open).toHaveBeenCalledTimes(1)
  })
})
