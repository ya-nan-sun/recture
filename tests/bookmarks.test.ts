import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MAX_BOOKMARK_NOTE,
  addBookmark,
  bookmarksPath,
  readBookmarks,
  removeBookmark,
  updateBookmark
} from '@main/bookmarks'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-bookmarks-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('bookmarks', () => {
  it('starts empty for a lecture without any', async () => {
    expect(await readBookmarks(dir)).toEqual([])
  })

  it('saves bookmarks in the lecture folder, ordered by position', async () => {
    await addBookmark(dir, 300, 'on the exam')
    await addBookmark(dir, 12.5)

    const list = await readBookmarks(dir)
    expect(list.map((b) => b.atSec)).toEqual([12.5, 300])
    expect(list[1]!.note).toBe('on the exam')
    // Lives on disk with the lecture, so it survives renames, moves and backups.
    await expect(fs.stat(bookmarksPath(dir))).resolves.toBeTruthy()
  })

  it('tidies notes and caps their length', async () => {
    const tidy = await addBookmark(dir, 1, '  on   the\n  exam  ')
    expect(tidy.note).toBe('on the exam')

    const long = await addBookmark(dir, 2, 'x'.repeat(MAX_BOOKMARK_NOTE * 3))
    expect(long.note).toHaveLength(MAX_BOOKMARK_NOTE)
  })

  it('keeps every bookmark when many are added at once', async () => {
    // Two quick presses of the bookmark key must give two bookmarks.
    const added = await Promise.all(Array.from({ length: 25 }, (_, i) => addBookmark(dir, i)))
    const list = await readBookmarks(dir)

    expect(list).toHaveLength(25)
    expect(new Set(list.map((b) => b.id)).size).toBe(25)
    expect(new Set(added.map((b) => b.id))).toEqual(new Set(list.map((b) => b.id)))
  })

  it('treats an impossible position as the start of the lecture', async () => {
    expect((await addBookmark(dir, -5)).atSec).toBe(0)
    expect((await addBookmark(dir, Number.NaN)).atSec).toBe(0)
  })

  it('updates and removes a bookmark by id', async () => {
    const a = await addBookmark(dir, 10, 'first')
    const b = await addBookmark(dir, 20, 'second')

    const updated = await updateBookmark(dir, a.id, 'renamed')
    expect(updated.find((x) => x.id === a.id)!.note).toBe('renamed')

    const remaining = await removeBookmark(dir, b.id)
    expect(remaining.map((x) => x.id)).toEqual([a.id])
    expect(await readBookmarks(dir)).toHaveLength(1)
  })

  it('refuses to update a bookmark that is gone', async () => {
    await expect(updateBookmark(dir, 'missing', 'note')).rejects.toThrow(/no longer exists/)
  })

  it('treats an unreadable bookmarks file as empty, and recovers on the next add', async () => {
    await fs.writeFile(bookmarksPath(dir), 'not json at all', 'utf8')
    expect(await readBookmarks(dir)).toEqual([])

    await addBookmark(dir, 5, 'after corruption')
    expect(await readBookmarks(dir)).toHaveLength(1)
  })
})
