/**
 * Which microphone to record with.
 *
 * The mic check used to keep the student's choice to itself, and recording
 * always opened the system default — so they could test the right microphone
 * and then record a whole lecture on the wrong one.
 */

export interface InputDevice {
  deviceId: string
  label: string
}

export interface DeviceChoice {
  /** Device to ask for, or undefined for the system default. */
  deviceId: string | undefined
  /** The saved microphone is not connected, so the default is used instead. */
  fellBack: boolean
}

export function chooseCaptureDevice(savedId: string | null | undefined, available: InputDevice[]): DeviceChoice {
  const wanted = (savedId ?? '').trim()
  if (!wanted || wanted === 'default') return { deviceId: undefined, fellBack: false }

  // Before microphone permission is granted the browser lists devices with
  // empty ids, so there is nothing to check against yet: trust the saved
  // choice, and let opening it fall back if it really is gone.
  const known = available.filter((d) => d.deviceId)
  if (known.length === 0) return { deviceId: wanted, fellBack: false }

  if (known.some((d) => d.deviceId === wanted)) return { deviceId: wanted, fellBack: false }
  return { deviceId: undefined, fellBack: true }
}

/**
 * The browser's way of saying a specific device could not be opened because
 * it is not there, as opposed to permission being denied (which falling back
 * to another microphone would not fix).
 */
export function isMissingDeviceError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError'
}

export interface OpenedDevice<T> {
  handle: T
  fellBack: boolean
}

/**
 * Open the saved microphone, or the system default if it has gone missing.
 * A recording always starts if any microphone at all is available.
 */
export async function openPreferredDevice<T>(
  savedId: string | null | undefined,
  available: InputDevice[],
  open: (deviceId: string | undefined) => Promise<T>
): Promise<OpenedDevice<T>> {
  const choice = chooseCaptureDevice(savedId, available)
  if (choice.deviceId === undefined) return { handle: await open(undefined), fellBack: choice.fellBack }
  try {
    return { handle: await open(choice.deviceId), fellBack: false }
  } catch (err) {
    if (!isMissingDeviceError(err)) throw err
    return { handle: await open(undefined), fellBack: true }
  }
}
