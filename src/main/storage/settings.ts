/**
 * App settings and API-key storage.
 *
 * Settings live in plain JSON in userData. API keys do not: they go through
 * Electron's `safeStorage`, which is backed by DPAPI on Windows, the Keychain
 * on macOS and libsecret on Linux, so the key is bound to the OS user account.
 *
 * Note on encrypting lecture audio at rest: we deliberately do NOT add an
 * app-level encryption layer. Every desktop OS this app targets ships
 * full-disk encryption (BitLocker / FileVault / LUKS), and rolling our own
 * would mean holding a key we cannot protect any better than the OS already
 * does — while making the recordings unrecoverable if the app's key store is
 * lost. `getDiskEncryptionHint()` surfaces the OS-level status instead so the
 * student can turn it on if it is off.
 */

import { app, safeStorage } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppSettings } from '@shared/types'
import { DEFAULT_SEGMENT_SECONDS } from '@shared/types'
import { resolveDefaultLibraryDir } from './migrateLegacy'

const execFileAsync = promisify(execFile)

const SETTINGS_FILE = 'settings.json'
const SECRETS_FILE = 'secrets.bin'

export function defaultSettings(): AppSettings {
  return {
    rootDir: resolveDefaultLibraryDir(app.getPath('documents'), 'Recture'),
    segmentSeconds: DEFAULT_SEGMENT_SECONDS,
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
    setupComplete: false
  }
}

export class SettingsStore {
  private cached: AppSettings | null = null

  constructor(private readonly userDataDir: string) {}

  private get file(): string {
    return path.join(this.userDataDir, SETTINGS_FILE)
  }

  get(): AppSettings {
    if (this.cached) return this.cached
    const defaults = defaultSettings()
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AppSettings>
      // Merge over defaults so a settings file written by an older build never
      // leaves a required field undefined.
      this.cached = { ...defaults, ...raw }
    } catch {
      this.cached = defaults
    }
    return this.cached
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch }
    fs.mkdirSync(this.userDataDir, { recursive: true })
    fs.writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.cached = next
    return next
  }

  // --- API keys ------------------------------------------------------------

  private get secretsFile(): string {
    return path.join(this.userDataDir, SECRETS_FILE)
  }

  private readSecrets(): Record<string, string> {
    try {
      const blob = fs.readFileSync(this.secretsFile)
      if (!safeStorage.isEncryptionAvailable()) return {}
      return JSON.parse(safeStorage.decryptString(blob)) as Record<string, string>
    } catch {
      return {}
    }
  }

  private writeSecrets(secrets: Record<string, string>): void {
    fs.mkdirSync(this.userDataDir, { recursive: true })
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'OS secret storage is unavailable, so the API key cannot be stored securely. ' +
          'Set the DEEPGRAM_API_KEY environment variable instead.'
      )
    }
    fs.writeFileSync(this.secretsFile, safeStorage.encryptString(JSON.stringify(secrets)))
  }

  getApiKey(provider: 'deepgram'): string | null {
    // An environment variable wins, so CI and power users never have to touch
    // the OS key store.
    const fromEnv = process.env[`${provider.toUpperCase()}_API_KEY`]
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
    return this.readSecrets()[provider] ?? null
  }

  setApiKey(provider: 'deepgram', key: string | null): void {
    const secrets = this.readSecrets()
    if (key && key.trim()) secrets[provider] = key.trim()
    else delete secrets[provider]
    this.writeSecrets(secrets)
    // A key lost in the rename has now been replaced.
    if (secrets[provider] && this.get().apiKeyReentryNotice) this.update({ apiKeyReentryNotice: false })
  }

  hasApiKey(provider: 'deepgram'): boolean {
    return this.getApiKey(provider) !== null
  }
}

export interface DiskEncryptionHint {
  /** null when we could not determine it — never claim "unprotected" on a guess. */
  encrypted: boolean | null
  detail: string
}

/**
 * Best-effort read of the OS full-disk-encryption state, shown in Settings so
 * the student can make an informed call about storing lectures on this device.
 */
export async function getDiskEncryptionHint(): Promise<DiskEncryptionHint> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-BitLockerVolume -MountPoint $env:SystemDrive).ProtectionStatus'],
        { timeout: 10_000, windowsHide: true }
      )
      const status = stdout.trim()
      if (status === 'On' || status === '1') return { encrypted: true, detail: 'BitLocker is on for the system drive.' }
      if (status === 'Off' || status === '0')
        return { encrypted: false, detail: 'BitLocker is off for the system drive. Recordings are stored unencrypted.' }
      return { encrypted: null, detail: 'Could not read BitLocker status.' }
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('fdesetup', ['status'], { timeout: 10_000 })
      if (/FileVault is On/i.test(stdout)) return { encrypted: true, detail: 'FileVault is on.' }
      return { encrypted: false, detail: 'FileVault is off. Recordings are stored unencrypted.' }
    }
    const { stdout } = await execFileAsync('lsblk', ['-o', 'TYPE'], { timeout: 10_000 })
    if (/crypt/.test(stdout)) return { encrypted: true, detail: 'A LUKS/dm-crypt volume is present.' }
    return { encrypted: null, detail: 'Could not determine disk encryption status.' }
  } catch {
    return { encrypted: null, detail: 'Could not determine disk encryption status on this system.' }
  }
}
