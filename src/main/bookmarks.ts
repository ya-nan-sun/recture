/**
 * Moments a student flagged while recording — "this will be on the exam".
 *
 * Kept in the lecture folder as bookmarks.json, so they travel with the lecture
 * through renames, moves and backups like everything else on disk. Writes are
 * serialized per lecture: two quick presses of the bookmark key must produce two
 * bookmarks, not one lost to a read-modify-write race.
 */

import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { Bookmark } from '@shared/types'
import { readJson, writeJsonAtomic } from './storage/paths'

interface BookmarksFile {
  version: 1
  bookmarks: Bookmark[]
}

export const MAX_BOOKMARK_NOTE = 500

export function bookmarksPath(lectureDir: string): string {
  return path.join(lectureDir, 'bookmarks.json')
}

const locks = new Map<string, Promise<unknown>>()

function withLock<T>(lectureDir: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(lectureDir)
  const previous = locks.get(key) ?? Promise.resolve()
  const next = previous.then(task)
  const settled = next.catch(() => undefined)
  locks.set(key, settled)
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}

function isBookmark(value: unknown): value is Bookmark {
  const b = value as Bookmark
  return (
    !!b &&
    typeof b.id === 'string' &&
    typeof b.atSec === 'number' &&
    Number.isFinite(b.atSec) &&
    typeof b.note === 'string' &&
    typeof b.createdAt === 'string'
  )
}

function cleanNote(note: unknown): string {
  return String(note ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BOOKMARK_NOTE)
}

async function load(lectureDir: string): Promise<Bookmark[]> {
  const file = await readJson<BookmarksFile>(bookmarksPath(lectureDir))
  const raw = file?.bookmarks
  const list = Array.isArray(raw) ? raw : []
  return list.filter(isBookmark).sort((a, b) => a.atSec - b.atSec)
}

async function save(lectureDir: string, bookmarks: Bookmark[]): Promise<void> {
  const file: BookmarksFile = { version: 1, bookmarks: [...bookmarks].sort((a, b) => a.atSec - b.atSec) }
  await writeJsonAtomic(bookmarksPath(lectureDir), file)
}

export function readBookmarks(lectureDir: string): Promise<Bookmark[]> {
  return load(lectureDir)
}

export function addBookmark(lectureDir: string, atSec: number, note = ''): Promise<Bookmark> {
  return withLock(lectureDir, async () => {
    const bookmark: Bookmark = {
      id: randomUUID(),
      atSec: Number.isFinite(atSec) ? Math.max(0, atSec) : 0,
      note: cleanNote(note),
      createdAt: new Date().toISOString()
    }
    await save(lectureDir, [...(await load(lectureDir)), bookmark])
    return bookmark
  })
}

export function updateBookmark(lectureDir: string, id: string, note: string): Promise<Bookmark[]> {
  return withLock(lectureDir, async () => {
    const existing = await load(lectureDir)
    const target = existing.find((b) => b.id === id)
    if (!target) throw new Error('That bookmark no longer exists.')
    target.note = cleanNote(note)
    await save(lectureDir, existing)
    return existing
  })
}

export function removeBookmark(lectureDir: string, id: string): Promise<Bookmark[]> {
  return withLock(lectureDir, async () => {
    const remaining = (await load(lectureDir)).filter((b) => b.id !== id)
    await save(lectureDir, remaining)
    return remaining
  })
}
