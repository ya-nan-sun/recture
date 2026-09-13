/**
 * Every change to a lecture's transcript goes through here: read, change,
 * write atomically — one change at a time per lecture. Accepting a suggestion
 * and saving an edit a moment apart must both land, not have the second
 * overwrite the first with a stale copy.
 */

import * as path from 'node:path'
import type { TranscriptFile } from '@shared/types'
import { lecturePaths, readJson, writeJsonAtomic } from './storage/paths'

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

export interface LoadedTranscript {
  transcript: TranscriptFile
  filePath: string
}

/** The final transcript if there is one, otherwise the live draft. */
export async function loadTranscriptFile(lectureDir: string): Promise<LoadedTranscript | null> {
  const paths = lecturePaths(lectureDir)
  const final = await readJson<TranscriptFile>(paths.transcript)
  if (final) return { transcript: final, filePath: paths.transcript }
  const live = await readJson<TranscriptFile>(paths.liveTranscript)
  return live ? { transcript: live, filePath: paths.liveTranscript } : null
}

/**
 * Apply `change` to the lecture's transcript and save the result to the file
 * it came from. A change that throws leaves the file untouched.
 */
export function updateTranscript(
  lectureDir: string,
  change: (transcript: TranscriptFile) => TranscriptFile
): Promise<TranscriptFile> {
  return withLock(lectureDir, async () => {
    const loaded = await loadTranscriptFile(lectureDir)
    if (!loaded) throw new Error('This lecture has no transcript yet.')
    const next = change(loaded.transcript)
    if (next !== loaded.transcript) await writeJsonAtomic(loaded.filePath, next)
    return next
  })
}
