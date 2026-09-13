import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { migrateLegacyUserData, resolveDefaultLibraryDir } from '@main/storage/migrateLegacy'

let root: string

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'recture-migrate-'))
})
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

function seedLegacy(name = 'lecturerec'): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ rootDir: 'D:/MyLectures' }))
  fs.writeFileSync(path.join(dir, 'secrets.bin'), Buffer.from([1, 2, 3, 4]))
  fs.writeFileSync(path.join(dir, 'lecturerec.db'), 'DBDATA')
  fs.writeFileSync(path.join(dir, 'lecturerec.db-wal'), 'WAL')
  return dir
}

describe('migrateLegacyUserData', () => {
  it('brings settings, secrets and the database across under new names', () => {
    seedLegacy()
    const target = path.join(root, 'Recture')

    const result = migrateLegacyUserData(target)

    expect(result.migrated).toBe(true)
    expect(fs.existsSync(path.join(target, 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(target, 'recture.db'))).toBe(true)
    // WAL must travel with the database or committed pages are lost.
    expect(fs.existsSync(path.join(target, 'recture.db-wal'))).toBe(true)

    // The saved API key must survive byte-for-byte.
    expect(fs.readFileSync(path.join(target, 'secrets.bin'))).toEqual(Buffer.from([1, 2, 3, 4]))
    // And the library location the student chose.
    expect(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).rootDir).toBe('D:/MyLectures')
  })

  it('leaves the legacy folder untouched', () => {
    const legacy = seedLegacy()
    migrateLegacyUserData(path.join(root, 'Recture'))
    expect(fs.existsSync(path.join(legacy, 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(legacy, 'lecturerec.db'))).toBe(true)
  })

  it('never overwrites an already-configured install', () => {
    seedLegacy()
    const target = path.join(root, 'Recture')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'settings.json'), JSON.stringify({ rootDir: 'KEEP ME' }))

    const result = migrateLegacyUserData(target)

    expect(result.migrated).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).rootDir).toBe('KEEP ME')
  })

  it('does nothing when there is no legacy install', () => {
    const result = migrateLegacyUserData(path.join(root, 'Recture'))
    expect(result.migrated).toBe(false)
    expect(result.files).toEqual([])
  })
})

describe('resolveDefaultLibraryDir', () => {
  it('adopts an existing library from the old name', () => {
    fs.mkdirSync(path.join(root, 'LectureRec', 'Classes'), { recursive: true })
    expect(resolveDefaultLibraryDir(root, 'Recture')).toBe(path.join(root, 'LectureRec'))
  })

  it('prefers the new name once it exists', () => {
    fs.mkdirSync(path.join(root, 'LectureRec'), { recursive: true })
    fs.mkdirSync(path.join(root, 'Recture'), { recursive: true })
    expect(resolveDefaultLibraryDir(root, 'Recture')).toBe(path.join(root, 'Recture'))
  })

  it('uses the new name on a clean machine', () => {
    expect(resolveDefaultLibraryDir(root, 'Recture')).toBe(path.join(root, 'Recture'))
  })
})
