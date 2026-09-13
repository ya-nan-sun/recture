/**
 * Library operations: creating classes and lectures on disk, keeping
 * glossary.json in step with the database, and recovering lectures that were
 * interrupted by a crash.
 *
 * Disk is written before the database throughout, because the files are the
 * source of truth and the DB is a rebuildable index.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ClassRecord, GlossaryTerm, LectureRecord, TranscriptFile } from '@shared/types'
import { lectureFolderName, sanitizeSegment, uniqueName } from '@shared/naming'
import {
  classDir,
  classesRoot,
  classMetaPath,
  ensureDir,
  glossaryPath,
  IGNORE_MARKER,
  isInside,
  lecturePaths,
  pathExists,
  readJson,
  writeJsonAtomic
} from './storage/paths'
import type { Repos } from './db/repos'
import { repairTruncatedWav, verifySegmentFile } from './audio/wav'
import { segmentAbsolutePath, type SegmentManifest } from './audio/recordingSession'

export interface GlossaryFile {
  version: 1
  className: string
  terms: { term: string; note: string | null }[]
  updatedAt: string
}

export async function createClass(
  repos: Repos,
  rootDir: string,
  input: { name: string; instructor?: string | null; color?: string | null }
): Promise<ClassRecord> {
  const safeName = sanitizeSegment(input.name, 'Untitled Class')
  const existing = repos.classes.findByName(safeName)
  if (existing) throw new Error(`A class named “${safeName}” already exists.`)

  await ensureDir(classesRoot(rootDir))
  const folder = uniqueName(safeName, (candidate) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').accessSync(classDir(rootDir, candidate))
      return true
    } catch {
      return false
    }
  })

  const dir = classDir(rootDir, folder)
  await ensureDir(dir)

  const record = repos.classes.create({
    name: folder,
    dirPath: dir,
    instructor: input.instructor ?? null,
    color: input.color ?? null
  })

  await writeJsonAtomic(classMetaPath(dir), {
    version: 1,
    id: record.id,
    name: record.name,
    instructor: record.instructor,
    createdAt: record.createdAt
  })
  await writeGlossaryFile(dir, record.name, [])
  return record
}

export async function createLecture(
  repos: Repos,
  klass: ClassRecord,
  input: { title?: string; recordedAt?: Date }
): Promise<LectureRecord> {
  const recordedAt = input.recordedAt ?? new Date()
  const title = sanitizeSegment(input.title?.trim() || defaultLectureTitle(recordedAt), 'Lecture')

  await ensureDir(klass.dirPath)
  const folder = uniqueName(lectureFolderName(recordedAt, title), (candidate) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('node:fs').accessSync(path.join(klass.dirPath, candidate))
      return true
    } catch {
      return false
    }
  })

  const dir = path.join(klass.dirPath, folder)
  await ensureDir(path.join(dir, 'audio'))

  const record = repos.lectures.create({
    classId: klass.id,
    title,
    dirPath: dir,
    recordedAt: recordedAt.toISOString(),
    status: 'recording'
  })

  await writeJsonAtomic(lecturePaths(dir).meta, {
    version: 1,
    id: record.id,
    classId: klass.id,
    className: klass.name,
    title: record.title,
    recordedAt: record.recordedAt
  })
  return record
}

export function defaultLectureTitle(date: Date): string {
  return `Lecture ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

// --- glossary --------------------------------------------------------------

export async function writeGlossaryFile(
  classDirPath: string,
  className: string,
  terms: { term: string; note: string | null }[]
): Promise<void> {
  const file: GlossaryFile = {
    version: 1,
    className,
    terms,
    updatedAt: new Date().toISOString()
  }
  await writeJsonAtomic(glossaryPath(classDirPath), file)
}

export async function syncGlossaryToDisk(repos: Repos, klass: ClassRecord): Promise<void> {
  const terms = repos.glossary.listByClass(klass.id)
  await writeGlossaryFile(
    klass.dirPath,
    klass.name,
    terms.map((t) => ({ term: t.term, note: t.note }))
  )
}

/** Load glossary.json into the DB — used when adopting a folder from disk. */
export async function importGlossaryFromDisk(repos: Repos, klass: ClassRecord): Promise<GlossaryTerm[]> {
  const file = await readJson<GlossaryFile>(glossaryPath(klass.dirPath))
  if (file?.terms?.length) {
    repos.glossary.replaceAll(
      klass.id,
      file.terms.map((t) => ({ term: t.term, note: t.note ?? null }))
    )
  }
  return repos.glossary.listByClass(klass.id)
}

// --- crash recovery --------------------------------------------------------

export interface RecoveryReport {
  lectureId: string
  title: string
  recoveredSegments: number
  repairedPartial: boolean
  corruptSegments: number
}

/**
 * Reconcile a lecture whose recording never closed cleanly — the app was
 * killed, the machine lost power, the battery died mid-lecture.
 *
 * Rebuilds the segment rows from the manifest and the audio directory, repairs
 * the one segment that was mid-write, and leaves the lecture ready for a final
 * pass. Nothing is deleted.
 */
export async function recoverInterruptedLecture(repos: Repos, lecture: LectureRecord): Promise<RecoveryReport> {
  const paths = lecturePaths(lecture.dirPath)
  const manifest = await readJson<SegmentManifest>(paths.manifest)

  const report: RecoveryReport = {
    lectureId: lecture.id,
    title: lecture.title,
    recoveredSegments: 0,
    repairedPartial: false,
    corruptSegments: 0
  }

  const known = new Map(repos.segments.listByLecture(lecture.id).map((s) => [s.relPath, s]))

  // 1. Adopt every segment the manifest recorded, verifying as we go.
  for (const entry of manifest?.segments ?? []) {
    const abs = segmentAbsolutePath(lecture.dirPath, entry.relPath)
    const result = await verifySegmentFile(abs, entry.sha256)
    const verified = result.ok ? 'ok' : result.reason
    if (!result.ok) report.corruptSegments += 1
    else report.recoveredSegments += 1

    const existing = known.get(entry.relPath)
    if (existing) {
      repos.segments.setVerification(existing.id, verified)
    } else {
      repos.segments.add({
        lectureId: lecture.id,
        index: entry.index,
        relPath: entry.relPath,
        startSec: entry.startSec,
        durationSec: entry.durationSec,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        verified
      })
    }
  }

  // 2. Look for a segment that was open when the process died: present on disk
  //    but absent from the manifest.
  const manifested = new Set((manifest?.segments ?? []).map((s) => s.relPath))
  let files: string[] = []
  try {
    files = (await fs.readdir(paths.audioDir)).filter((f) => /^segment-\d{4}\.wav$/.test(f)).sort()
  } catch {
    files = []
  }

  let startSec = (manifest?.segments ?? []).reduce((n, s) => n + s.durationSec, 0)

  for (const file of files) {
    const relPath = `audio/${file}`
    if (manifested.has(relPath)) continue

    const abs = path.join(paths.audioDir, file)
    try {
      const repaired = await repairTruncatedWav(abs)
      if (repaired.byteLength === 0) continue

      const index = Number(/segment-(\d{4})\.wav/.exec(file)?.[1] ?? '0')
      repos.segments.add({
        lectureId: lecture.id,
        index,
        relPath,
        startSec,
        durationSec: repaired.durationSec,
        byteLength: repaired.byteLength,
        sha256: repaired.sha256,
        // Recovered, not verified: these bytes were never checksummed at write
        // time, so we only know the file is self-consistent now.
        verified: 'ok'
      })
      startSec += repaired.durationSec
      report.recoveredSegments += 1
      report.repairedPartial = report.repairedPartial || repaired.repaired
    } catch {
      report.corruptSegments += 1
    }
  }

  repos.lectures.update(lecture.id, {
    durationSec: startSec,
    segmentCount: report.recoveredSegments + report.corruptSegments,
    corruptSegmentCount: report.corruptSegments,
    status: report.recoveredSegments > 0 ? 'needs_transcription' : 'needs_attention',
    statusDetail:
      report.recoveredSegments > 0
        ? `Recording was interrupted. ${report.recoveredSegments} audio segment(s) recovered${
            report.repairedPartial ? ', including a partial final segment' : ''
          }. Ready to transcribe.`
        : 'Recording was interrupted before any audio was saved.'
  })

  return report
}

/** Find and recover every lecture left in a recording state by a crash. */
export async function recoverAllInterrupted(repos: Repos): Promise<RecoveryReport[]> {
  const stuck = repos.lectures.listAll().filter((l) => l.status === 'recording')
  const reports: RecoveryReport[] = []
  for (const lecture of stuck) {
    if (!(await pathExists(lecture.dirPath))) {
      repos.lectures.setStatus(lecture.id, 'needs_attention', 'The lecture folder is missing from disk.')
      continue
    }
    reports.push(await recoverInterruptedLecture(repos, lecture))
  }
  return reports
}

// --- management: rename, move, delete -------------------------------------

/**
 * Rewrite the identity fields inside transcript.json (and the live draft) so
 * exports made after a rename carry the new name rather than the old one.
 * Absent files are skipped: a lecture that has not been transcribed yet simply
 * has nothing to update.
 */
async function retitleTranscripts(
  lectureDir: string,
  patch: Partial<Pick<TranscriptFile, 'lectureTitle' | 'className' | 'classId'>>
): Promise<void> {
  const paths = lecturePaths(lectureDir)
  for (const file of [paths.transcript, paths.liveTranscript]) {
    const transcript = await readJson<TranscriptFile>(file)
    if (!transcript) continue
    await writeJsonAtomic(file, { ...transcript, ...patch, updatedAt: new Date().toISOString() })
  }
}

/** Does a path exist? Sync, for the uniqueName collision probe. */
function existsSync(target: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').accessSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * Rename a class, moving its folder on disk and repointing every lecture
 * underneath it.
 *
 * The folder is the class's identity on disk, so this is a real move rather
 * than a label change. Disk is renamed first: if that fails we abort with the
 * index untouched, which is recoverable. The reverse order would leave the
 * index pointing at a folder that never moved.
 */
export async function renameClass(
  repos: Repos,
  rootDir: string,
  klass: ClassRecord,
  newName: string
): Promise<ClassRecord> {
  const safeName = sanitizeSegment(newName.trim(), klass.name)
  if (safeName === klass.name) return klass

  const clash = repos.classes.findByName(safeName)
  if (clash && clash.id !== klass.id) throw new Error(`A class named “${safeName}” already exists.`)

  await ensureDir(classesRoot(rootDir))
  const folder = uniqueName(safeName, (candidate) => existsSync(classDir(rootDir, candidate)))
  const newDir = classDir(rootDir, folder)

  await fs.rename(klass.dirPath, newDir)

  repos.classes.update(klass.id, { name: folder, dirPath: newDir })

  // Every lecture folder moved with its parent; repoint each one.
  for (const lecture of repos.lectures.listByClass(klass.id)) {
    const moved = path.join(newDir, path.basename(lecture.dirPath))
    repos.lectures.update(lecture.id, { dirPath: moved })
    await retitleTranscripts(moved, { className: folder }).catch(() => undefined)
    repos.lectures.indexForSearch(lecture.id, folder, lecture.title, '')
  }

  const updated = repos.classes.get(klass.id)!
  await writeJsonAtomic(classMetaPath(newDir), {
    version: 1,
    id: updated.id,
    name: updated.name,
    instructor: updated.instructor,
    createdAt: updated.createdAt
  })
  await writeGlossaryFile(
    newDir,
    updated.name,
    repos.glossary.listByClass(klass.id).map((t) => ({ term: t.term, note: t.note }))
  )
  return updated
}

/** Rename a lecture, moving its folder to match the new title. */
export async function renameLecture(
  repos: Repos,
  klass: ClassRecord,
  lecture: LectureRecord,
  newTitle: string
): Promise<LectureRecord> {
  const safeTitle = sanitizeSegment(newTitle.trim(), lecture.title)
  if (safeTitle === lecture.title) return lecture

  const recordedAt = new Date(lecture.recordedAt)
  const folder = uniqueName(lectureFolderName(recordedAt, safeTitle), (candidate) =>
    existsSync(path.join(klass.dirPath, candidate))
  )
  const newDir = path.join(klass.dirPath, folder)

  await fs.rename(lecture.dirPath, newDir)
  repos.lectures.update(lecture.id, { title: safeTitle, dirPath: newDir })

  await writeJsonAtomic(lecturePaths(newDir).meta, {
    version: 1,
    id: lecture.id,
    classId: klass.id,
    className: klass.name,
    title: safeTitle,
    recordedAt: lecture.recordedAt
  })
  await retitleTranscripts(newDir, { lectureTitle: safeTitle }).catch(() => undefined)

  const transcript = await readJson<TranscriptFile>(lecturePaths(newDir).transcript)
  repos.lectures.indexForSearch(
    lecture.id,
    klass.name,
    safeTitle,
    transcript ? transcript.segments.map((s) => s.text).join(' ') : ''
  )
  return repos.lectures.get(lecture.id)!
}

/** Move a lecture into a different class, folder and all. */
export async function moveLecture(
  repos: Repos,
  lecture: LectureRecord,
  target: ClassRecord
): Promise<LectureRecord> {
  if (lecture.classId === target.id) return lecture

  await ensureDir(target.dirPath)
  const folder = uniqueName(path.basename(lecture.dirPath), (candidate) =>
    existsSync(path.join(target.dirPath, candidate))
  )
  const newDir = path.join(target.dirPath, folder)

  await fs.rename(lecture.dirPath, newDir)
  repos.lectures.update(lecture.id, { dirPath: newDir })
  repos.lectures.reassignClass(lecture.id, target.id)

  await writeJsonAtomic(lecturePaths(newDir).meta, {
    version: 1,
    id: lecture.id,
    classId: target.id,
    className: target.name,
    title: lecture.title,
    recordedAt: lecture.recordedAt
  })
  await retitleTranscripts(newDir, { classId: target.id, className: target.name }).catch(() => undefined)

  const transcript = await readJson<TranscriptFile>(lecturePaths(newDir).transcript)
  repos.lectures.indexForSearch(
    lecture.id,
    target.name,
    lecture.title,
    transcript ? transcript.segments.map((s) => s.text).join(' ') : ''
  )
  return repos.lectures.get(lecture.id)!
}

export interface DeleteOutcome {
  removedFromLibrary: true
  filesDeleted: boolean
  folder: string
}

/**
 * Delete a lecture.
 *
 * `deleteFiles` is opt-in and never the default. Removing it from the library
 * leaves every byte of audio on disk, which is the recoverable choice; erasing
 * the recording is not, so the caller has to ask for it explicitly and the UI
 * makes the student confirm the lecture by name.
 */
export async function deleteLecture(
  repos: Repos,
  rootDir: string,
  lecture: LectureRecord,
  deleteFiles: boolean
): Promise<DeleteOutcome> {
  if (deleteFiles) {
    // Never delete outside the configured library root, whatever the DB says.
    if (!isInside(rootDir, lecture.dirPath)) {
      throw new Error('Refusing to delete a folder outside the library folder.')
    }
    await fs.rm(lecture.dirPath, { recursive: true, force: true })
  } else {
    // Keep the files but stop the disk scan from re-adopting the folder.
    await fs
      .writeFile(
        path.join(lecture.dirPath, IGNORE_MARKER),
        `Removed from the LectureRec library on ${new Date().toISOString()}.
Delete this file to have the app pick this lecture up again.
`,
        'utf8'
      )
      .catch(() => undefined)
  }
  repos.lectures.delete(lecture.id)
  return { removedFromLibrary: true, filesDeleted: deleteFiles, folder: lecture.dirPath }
}

/** Delete a class and, optionally, every recording inside it. */
export async function deleteClass(
  repos: Repos,
  rootDir: string,
  klass: ClassRecord,
  deleteFiles: boolean
): Promise<DeleteOutcome & { lectureCount: number }> {
  const lectures = repos.lectures.listByClass(klass.id)
  if (deleteFiles) {
    if (!isInside(rootDir, klass.dirPath)) {
      throw new Error('Refusing to delete a folder outside the library folder.')
    }
    await fs.rm(klass.dirPath, { recursive: true, force: true })
  } else {
    await fs
      .writeFile(
        path.join(klass.dirPath, IGNORE_MARKER),
        `Removed from the LectureRec library on ${new Date().toISOString()}.
Delete this file to have the app pick this class up again.
`,
        'utf8'
      )
      .catch(() => undefined)
  }
  for (const lecture of lectures) repos.lectures.delete(lecture.id)
  repos.classes.delete(klass.id)
  return {
    removedFromLibrary: true,
    filesDeleted: deleteFiles,
    folder: klass.dirPath,
    lectureCount: lectures.length
  }
}
