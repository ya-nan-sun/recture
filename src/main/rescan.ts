/**
 * Reconciles the SQLite index with what is actually on disk.
 *
 * This is what makes "the files are the source of truth" true rather than
 * merely claimed. The student can rename a class folder in Explorer, drag a
 * lecture into a different class, delete a folder, or restore one from a
 * backup, and the next scan makes the app agree with the filesystem.
 *
 * Identity comes from the `id` written into `class.json` / `lecture.json`, not
 * from the folder path. That is the whole trick: a folder renamed or moved on
 * disk keeps its id, so it is recognised as the *same* class or lecture and
 * updated in place — preserving its glossary, its status and its history —
 * rather than being deleted and re-adopted as a stranger.
 *
 * Nothing here ever writes into a lecture's audio or deletes a file. The only
 * destructive action is removing an index row whose folder is gone, which is
 * exactly what the student asked for by deleting the folder.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ClassRecord, LectureStatus, TranscriptFile } from '@shared/types'
import { localDateStamp } from '@shared/naming'
import type { Repos } from './db/repos'
import {
  classesRoot,
  classMetaPath,
  ensureDir,
  glossaryPath,
  IGNORE_MARKER,
  lecturePaths,
  readJson,
  writeJsonAtomic
} from './storage/paths'
import type { SegmentManifest } from './audio/recordingSession'
import type { GlossaryFile } from './library'

interface ClassMeta {
  version: number
  id: string
  name: string
  instructor: string | null
  createdAt: string
}

interface LectureMeta {
  version: number
  id: string
  classId: string
  className: string
  title: string
  recordedAt: string
}

export interface RescanReport {
  classesAdopted: number
  classesUpdated: number
  classesRemoved: number
  lecturesAdopted: number
  lecturesUpdated: number
  lecturesRemoved: number
  /** Human-readable lines for the UI, newest-first. */
  details: string[]
}

const emptyReport = (): RescanReport => ({
  classesAdopted: 0,
  classesUpdated: 0,
  classesRemoved: 0,
  lecturesAdopted: 0,
  lecturesUpdated: 0,
  lecturesRemoved: 0,
  details: []
})

export function reportIsEmpty(report: RescanReport): boolean {
  return (
    report.classesAdopted === 0 &&
    report.classesUpdated === 0 &&
    report.classesRemoved === 0 &&
    report.lecturesAdopted === 0 &&
    report.lecturesUpdated === 0 &&
    report.lecturesRemoved === 0
  )
}

/** A folder the student removed from the library but chose to keep on disk. */
async function isIgnored(dir: string): Promise<boolean> {
  return fs
    .stat(path.join(dir, IGNORE_MARKER))
    .then(() => true)
    .catch(() => false)
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/** Recover a date from `YYYY-MM-DD - Title`, else fall back to the folder's mtime. */
async function inferRecordedAt(lectureDir: string, folderName: string): Promise<string> {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(folderName)
  if (match) {
    const [, y, m, d] = match
    const parsed = new Date(Number(y), Number(m) - 1, Number(d), 12)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  try {
    return (await fs.stat(lectureDir)).mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

function titleFromFolder(folderName: string): string {
  // `2026-09-12 - Week 3` -> `Week 3`
  const stripped = folderName.replace(/^\d{4}-\d{2}-\d{2}\s*-\s*/, '').trim()
  return stripped || folderName
}

export interface RescanOptions {
  /** Never touch the lecture currently being recorded into. */
  protectLectureId?: string | null
}

export async function rescanLibrary(
  repos: Repos,
  rootDir: string,
  options: RescanOptions = {}
): Promise<RescanReport> {
  const report = emptyReport()
  const root = classesRoot(rootDir)
  await ensureDir(root)

  const seenClassIds = new Set<string>()
  const seenLectureIds = new Set<string>()

  for (const classFolder of await listDirectories(root)) {
    const classPath = path.join(root, classFolder)
    if (await isIgnored(classPath)) continue
    const meta = await readJson<ClassMeta>(classMetaPath(classPath))

    let klass: ClassRecord | null = meta?.id ? repos.classes.get(meta.id) : null

    if (klass) {
      // Known class. Folder may have been renamed or moved underneath us.
      if (klass.name !== classFolder || klass.dirPath !== classPath) {
        repos.classes.update(klass.id, { name: classFolder, dirPath: classPath })
        report.classesUpdated += 1
        report.details.push(`Class “${klass.name}” is now “${classFolder}”.`)
        klass = repos.classes.get(klass.id)
      }
    } else {
      // A folder we have never seen: adopt it, keeping its id if it has one.
      const byName = repos.classes.findByName(classFolder)
      if (byName && !meta?.id) {
        klass = byName
      } else {
        const id = meta?.id ?? randomUUID()
        klass = repos.classes.create({
          id,
          name: classFolder,
          dirPath: classPath,
          instructor: meta?.instructor ?? null,
          createdAt: meta?.createdAt
        })
        report.classesAdopted += 1
        report.details.push(`Added class “${classFolder}” found on disk.`)

        // Write class.json so the folder carries its identity from now on.
        await writeJsonAtomic(classMetaPath(classPath), {
          version: 1,
          id: klass.id,
          name: klass.name,
          instructor: klass.instructor,
          createdAt: klass.createdAt
        }).catch(() => undefined)
      }

      // Adopt whatever glossary the folder came with.
      const glossary = await readJson<GlossaryFile>(glossaryPath(classPath))
      if (glossary?.terms?.length && repos.glossary.listByClass(klass.id).length === 0) {
        repos.glossary.replaceAll(
          klass.id,
          glossary.terms.map((t) => ({ term: t.term, note: t.note ?? null }))
        )
      }
    }

    if (!klass) continue
    seenClassIds.add(klass.id)

    // --- lectures inside this class ----------------------------------------
    for (const lectureFolder of await listDirectories(classPath)) {
      const lectureDir = path.join(classPath, lectureFolder)
      if (await isIgnored(lectureDir)) continue
      const paths = lecturePaths(lectureDir)
      const lectureMeta = await readJson<LectureMeta>(paths.meta)
      const existing = lectureMeta?.id ? repos.lectures.get(lectureMeta.id) : null

      if (existing) {
        seenLectureIds.add(existing.id)
        const movedClass = existing.classId !== klass.id
        const movedDir = existing.dirPath !== lectureDir
        if (movedClass || movedDir) {
          if (movedDir) repos.lectures.update(existing.id, { dirPath: lectureDir })
          if (movedClass) repos.lectures.reassignClass(existing.id, klass.id)
          report.lecturesUpdated += 1
          report.details.push(
            movedClass
              ? `Lecture “${existing.title}” moved into “${klass.name}”.`
              : `Lecture “${existing.title}” moved to a new folder.`
          )
        }
        continue
      }

      // A lecture folder with no matching row: adopt it.
      const manifest = await readJson<SegmentManifest>(paths.manifest)
      const transcript = await readJson<TranscriptFile>(paths.transcript)
      const segments = manifest?.segments ?? []

      // Only adopt folders that actually look like a lecture.
      if (segments.length === 0 && !transcript && !lectureMeta) continue

      const status: LectureStatus = transcript
        ? 'complete'
        : segments.length > 0
          ? 'needs_transcription'
          : 'needs_attention'

      const created = repos.lectures.create({
        id: lectureMeta?.id,
        classId: klass.id,
        title: lectureMeta?.title ?? transcript?.lectureTitle ?? titleFromFolder(lectureFolder),
        dirPath: lectureDir,
        recordedAt:
          lectureMeta?.recordedAt ?? transcript?.recordedAt ?? (await inferRecordedAt(lectureDir, lectureFolder)),
        status,
        statusDetail: transcript
          ? null
          : segments.length > 0
            ? 'Found on disk with audio but no transcript. Ready to transcribe.'
            : 'Found on disk, but no audio segments were present.'
      })

      for (const entry of segments) {
        repos.segments.add({
          lectureId: created.id,
          index: entry.index,
          relPath: entry.relPath,
          startSec: entry.startSec,
          durationSec: entry.durationSec,
          byteLength: entry.byteLength,
          sha256: entry.sha256,
          // Unverified until the next transcription pass re-hashes them.
          verified: 'pending'
        })
      }

      repos.lectures.update(created.id, {
        segmentCount: segments.length,
        durationSec: transcript?.durationSec ?? segments.reduce((n, s) => n + s.durationSec, 0),
        transcriptSource: transcript ? `${transcript.source.provider} · ${transcript.source.model}` : null,
        transcriptPass: transcript?.source.pass ?? null
      })

      if (transcript) {
        repos.lectures.indexForSearch(
          created.id,
          klass.name,
          created.title,
          transcript.segments.map((s) => s.text).join(' ')
        )
      }

      // Stamp identity onto the folder so it is recognised next time.
      if (!lectureMeta?.id) {
        await writeJsonAtomic(paths.meta, {
          version: 1,
          id: created.id,
          classId: klass.id,
          className: klass.name,
          title: created.title,
          recordedAt: created.recordedAt
        }).catch(() => undefined)
      }

      seenLectureIds.add(created.id)
      report.lecturesAdopted += 1
      report.details.push(`Added lecture “${created.title}” found in “${klass.name}”.`)
    }
  }

  // --- drop index rows whose folders are gone -------------------------------
  for (const lecture of repos.lectures.listAll()) {
    if (seenLectureIds.has(lecture.id)) continue
    // Never evict the lecture being recorded into: its folder exists, it just
    // may not have been scannable at this instant.
    if (options.protectLectureId && lecture.id === options.protectLectureId) continue
    repos.lectures.delete(lecture.id)
    report.lecturesRemoved += 1
    report.details.push(`Removed “${lecture.title}” — its folder is no longer on disk.`)
  }

  for (const klass of repos.classes.list()) {
    if (seenClassIds.has(klass.id)) continue
    repos.classes.delete(klass.id)
    report.classesRemoved += 1
    report.details.push(`Removed class “${klass.name}” — its folder is no longer on disk.`)
  }

  return report
}

/**
 * Watches the library folder and reconciles after changes settle.
 *
 * Deliberately coarse: any change triggers a full rescan after a debounce,
 * rather than trying to interpret individual filesystem events. A rescan is
 * cheap (it reads small JSON files, never audio), and event-level
 * interpretation is where this kind of code usually goes wrong — Explorer
 * renames arrive as unordered create/delete pairs.
 */
export class LibraryWatcher {
  private watcher: { close: () => void } | null = null
  private timer: NodeJS.Timeout | null = null
  private running = false
  private rerun = false

  constructor(
    private readonly getRootDir: () => string,
    private readonly onRescan: (report: RescanReport) => void,
    private readonly runRescan: () => Promise<RescanReport>,
    private readonly debounceMs = 1200
  ) {}

  async start(): Promise<void> {
    await this.stop()
    const root = classesRoot(this.getRootDir())
    await ensureDir(root)
    try {
      // `recursive` is supported on Windows and macOS; on Linux this still
      // catches top-level changes, and the startup scan covers the rest.
      const watcher = (await import('node:fs')).watch(root, { recursive: true }, () => this.schedule())
      watcher.on('error', () => undefined)
      this.watcher = watcher
    } catch {
      // A missing or unwatchable folder is not fatal — manual refresh still works.
      this.watcher = null
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.fire(), this.debounceMs)
  }

  private async fire(): Promise<void> {
    if (this.running) {
      // Changes arrived mid-scan; go round once more when this one finishes.
      this.rerun = true
      return
    }
    this.running = true
    try {
      const report = await this.runRescan()
      if (!reportIsEmpty(report)) this.onRescan(report)
    } catch {
      // Never let a scan failure take down the app.
    } finally {
      this.running = false
      if (this.rerun) {
        this.rerun = false
        this.schedule()
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.watcher?.close()
    this.watcher = null
  }
}

export function describeRescan(report: RescanReport): string {
  const parts: string[] = []
  const add = (n: number, singular: string): void => {
    if (n > 0) parts.push(`${n} ${singular}${n === 1 ? '' : 's'}`)
  }
  add(report.classesAdopted + report.lecturesAdopted, 'item added')
  add(report.classesUpdated + report.lecturesUpdated, 'item moved')
  add(report.classesRemoved + report.lecturesRemoved, 'item removed')
  return parts.length > 0 ? `Library synced: ${parts.join(', ')}.` : 'Library is already up to date.'
}
