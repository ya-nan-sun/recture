/**
 * One-time migration from the app's former name (LectureRec).
 *
 * Electron derives the userData folder from the product name, so renaming the
 * app silently moves it — `%APPDATA%/lecturerec` becomes `%APPDATA%/Recture`.
 * Without this, a rename would look to the user like the app forgot their
 * settings, their saved API key and their whole library, while the old data sat
 * untouched in a folder they would never think to look in.
 *
 * Nothing is deleted. The legacy folder is left exactly as it is, so an older
 * build still works and the migration can simply be run again if it goes wrong.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Former userData folder names, newest first. */
const LEGACY_APP_DIRS = ['lecturerec', 'LectureRec']

/** Former default library folder names, relative to Documents. */
export const LEGACY_LIBRARY_DIRS = ['LectureRec']

export interface MigrationResult {
  migrated: boolean
  from: string | null
  files: string[]
  /**
   * True when the old install had a saved API key that cannot be carried over.
   * The UI tells the student to re-enter it rather than leaving them wondering
   * why the provider suddenly says it is not configured.
   */
  apiKeyNeedsReentry: boolean
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // keep looking
    }
  }
  return null
}

/**
 * Copy settings, saved secrets and the index database out of the old userData
 * folder, if the new one has not been set up yet.
 */
export function migrateLegacyUserData(userDataDir: string): MigrationResult {
  const result: MigrationResult = { migrated: false, from: null, files: [], apiKeyNeedsReentry: false }

  // Already set up under the new name — never overwrite live data.
  const alreadyConfigured =
    fs.existsSync(path.join(userDataDir, 'settings.json')) || fs.existsSync(path.join(userDataDir, 'recture.db'))
  if (alreadyConfigured) return result

  const parent = path.dirname(userDataDir)
  const legacyDir = firstExisting(LEGACY_APP_DIRS.map((name) => path.join(parent, name)))
  if (!legacyDir || path.resolve(legacyDir) === path.resolve(userDataDir)) return result

  // `-wal` and `-shm` carry committed pages that may not be in the main file
  // yet, so the database is only consistent if all three travel together.
  //
  // `secrets.bin` is deliberately NOT copied. On Windows, safeStorage encrypts
  // with a random key held in Chromium's own `Local State` inside userData, so
  // the blob is meaningless without that file — copying it just produces a
  // secrets file that can never be decrypted. Re-pasting an API key takes a
  // moment; a silently unreadable one is worse than an obviously absent one.
  const copies: [string, string][] = [
    ['settings.json', 'settings.json'],
    ['lecturerec.db', 'recture.db'],
    ['lecturerec.db-wal', 'recture.db-wal'],
    ['lecturerec.db-shm', 'recture.db-shm']
  ]

  try {
    fs.mkdirSync(userDataDir, { recursive: true })
    for (const [from, to] of copies) {
      const source = path.join(legacyDir, from)
      if (!fs.existsSync(source)) continue
      fs.copyFileSync(source, path.join(userDataDir, to))
      result.files.push(to)
    }
  } catch {
    // A failed migration must not stop the app from starting; the student just
    // gets a fresh setup, and the old folder is still there to recover from.
    return result
  }

  result.migrated = result.files.length > 0
  result.from = result.migrated ? legacyDir : null
  result.apiKeyNeedsReentry = result.migrated && fs.existsSync(path.join(legacyDir, 'secrets.bin'))
  return result
}

/**
 * Where a brand-new install should put its library.
 *
 * If a library from the old name is sitting in Documents and the new default
 * does not exist yet, keep using the old one rather than stranding recordings.
 */
export function resolveDefaultLibraryDir(documentsDir: string, preferredName: string): string {
  const preferred = path.join(documentsDir, preferredName)
  if (fs.existsSync(preferred)) return preferred

  const legacy = firstExisting(LEGACY_LIBRARY_DIRS.map((name) => path.join(documentsDir, name)))
  return legacy ?? preferred
}
