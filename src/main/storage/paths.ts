/**
 * On-disk layout. The files are the durable source of truth; the SQLite
 * database is an index over them and can be rebuilt by rescanning.
 *
 *   <root>/
 *     Classes/
 *       <Class Name>/
 *         glossary.json
 *         class.json
 *         <YYYY-MM-DD - Title>/
 *           lecture.json
 *           audio/
 *             segments.json        manifest: checksums + verification state
 *             segment-0001.wav …
 *             final.wav
 *           transcript.json        source of truth for every export
 *           transcript.live.json   live draft, kept only as a fallback
 *           transcript.md
 *           transcript.pdf
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { segmentFileName } from '@shared/naming'

export const CLASSES_DIRNAME = 'Classes'

/**
 * Dropped into a folder the student removed from the library while choosing to
 * keep the files. Without it the disk scan would re-adopt the folder within
 * seconds and "remove from library" would be a no-op.
 *
 * Deleting this file by hand re-admits the folder on the next scan, which is
 * the obvious way to undo a removal.
 */
export const IGNORE_MARKER = '.lecturerec-ignore'

export interface LecturePaths {
  dir: string
  audioDir: string
  manifest: string
  finalAudio: string
  transcript: string
  liveTranscript: string
  markdown: string
  pdf: string
  meta: string
}

export function classesRoot(rootDir: string): string {
  return path.join(rootDir, CLASSES_DIRNAME)
}

export function classDir(rootDir: string, className: string): string {
  return path.join(classesRoot(rootDir), className)
}

export function glossaryPath(classDirPath: string): string {
  return path.join(classDirPath, 'glossary.json')
}

export function classMetaPath(classDirPath: string): string {
  return path.join(classDirPath, 'class.json')
}

export function lecturePaths(lectureDir: string): LecturePaths {
  const audioDir = path.join(lectureDir, 'audio')
  return {
    dir: lectureDir,
    audioDir,
    manifest: path.join(audioDir, 'segments.json'),
    finalAudio: path.join(audioDir, 'final.wav'),
    transcript: path.join(lectureDir, 'transcript.json'),
    liveTranscript: path.join(lectureDir, 'transcript.live.json'),
    markdown: path.join(lectureDir, 'transcript.md'),
    pdf: path.join(lectureDir, 'transcript.pdf'),
    meta: path.join(lectureDir, 'lecture.json')
  }
}

export function segmentPath(lectureDir: string, index: number): string {
  return path.join(lectureDir, 'audio', segmentFileName(index))
}

/** Path of a segment relative to its lecture dir, with forward slashes. */
export function segmentRelPath(index: number): string {
  return `audio/${segmentFileName(index)}`
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

export function pathExistsSync(target: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').accessSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * Write JSON durably: write a sibling temp file, fsync it, then rename over
 * the target. Rename is atomic within a directory, so a crash mid-write can
 * never leave a half-written transcript.json where a complete one used to be.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.tmp`
  const body = `${JSON.stringify(value, null, 2)}\n`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, filePath)
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

/** Guard against a path escaping the configured root via `..` or a symlink. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
