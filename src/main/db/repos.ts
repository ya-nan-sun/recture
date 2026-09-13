/** Typed repositories over the SQLite index. */

import { randomUUID } from 'node:crypto'
import type { Db } from './database'
import type {
  ClassRecord,
  GlossaryTerm,
  LectureRecord,
  LectureStatus,
  SegmentRecord,
  SegmentVerification,
  TranscriptPass
} from '@shared/types'

const nowIso = (): string => new Date().toISOString()

// --- row shapes (snake_case as stored) ------------------------------------

interface ClassRow {
  id: string
  name: string
  dir_path: string
  instructor: string | null
  color: string | null
  created_at: string
  updated_at: string
}

interface LectureRow {
  id: string
  class_id: string
  title: string
  dir_path: string
  recorded_at: string
  duration_sec: number
  status: string
  status_detail: string | null
  transcript_source: string | null
  transcript_pass: string | null
  segment_count: number
  corrupt_segment_count: number
  created_at: string
  updated_at: string
}

interface SegmentRow {
  id: string
  lecture_id: string
  idx: number
  rel_path: string
  start_sec: number
  duration_sec: number
  byte_length: number
  sha256: string
  verified: string
  created_at: string
}

interface GlossaryRow {
  id: string
  class_id: string
  term: string
  note: string | null
  created_at: string
}

const toClass = (r: ClassRow): ClassRecord => ({
  id: r.id,
  name: r.name,
  dirPath: r.dir_path,
  instructor: r.instructor,
  color: r.color,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toLecture = (r: LectureRow): LectureRecord => ({
  id: r.id,
  classId: r.class_id,
  title: r.title,
  dirPath: r.dir_path,
  recordedAt: r.recorded_at,
  durationSec: r.duration_sec,
  status: r.status as LectureStatus,
  statusDetail: r.status_detail,
  transcriptSource: r.transcript_source,
  transcriptPass: r.transcript_pass as TranscriptPass | null,
  segmentCount: r.segment_count,
  corruptSegmentCount: r.corrupt_segment_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toSegment = (r: SegmentRow): SegmentRecord => ({
  id: r.id,
  lectureId: r.lecture_id,
  index: r.idx,
  relPath: r.rel_path,
  startSec: r.start_sec,
  durationSec: r.duration_sec,
  byteLength: r.byte_length,
  sha256: r.sha256,
  verified: r.verified as SegmentVerification,
  createdAt: r.created_at
})

const toGlossary = (r: GlossaryRow): GlossaryTerm => ({
  id: r.id,
  classId: r.class_id,
  term: r.term,
  note: r.note,
  createdAt: r.created_at
})

// --- classes ---------------------------------------------------------------

export class ClassRepo {
  constructor(private readonly db: Db) {}

  /** `id` is supplied when adopting a folder from disk, to preserve identity. */
  create(input: {
    name: string
    dirPath: string
    instructor?: string | null
    color?: string | null
    id?: string
    createdAt?: string
  }): ClassRecord {
    const ts = nowIso()
    const row: ClassRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      dir_path: input.dirPath,
      instructor: input.instructor ?? null,
      color: input.color ?? null,
      created_at: input.createdAt ?? ts,
      updated_at: ts
    }
    this.db
      .prepare(
        `INSERT INTO classes (id, name, dir_path, instructor, color, created_at, updated_at)
         VALUES (@id, @name, @dir_path, @instructor, @color, @created_at, @updated_at)`
      )
      .run(row)
    return toClass(row)
  }

  list(): ClassRecord[] {
    return (this.db.prepare('SELECT * FROM classes ORDER BY name COLLATE NOCASE').all() as ClassRow[]).map(toClass)
  }

  get(id: string): ClassRecord | null {
    const row = this.db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as ClassRow | undefined
    return row ? toClass(row) : null
  }

  findByName(name: string): ClassRecord | null {
    const row = this.db.prepare('SELECT * FROM classes WHERE name = ?').get(name) as ClassRow | undefined
    return row ? toClass(row) : null
  }

  update(id: string, patch: { name?: string; dirPath?: string; instructor?: string | null; color?: string | null }): void {
    const existing = this.get(id)
    if (!existing) throw new Error(`No such class: ${id}`)
    this.db
      .prepare(
        `UPDATE classes SET name = ?, dir_path = ?, instructor = ?, color = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        patch.name ?? existing.name,
        patch.dirPath ?? existing.dirPath,
        patch.instructor === undefined ? existing.instructor : patch.instructor,
        patch.color === undefined ? existing.color : patch.color,
        nowIso(),
        id
      )
  }

  /** Removes the index rows only. Files on disk are never touched here. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM classes WHERE id = ?').run(id)
  }
}

// --- lectures --------------------------------------------------------------

export class LectureRepo {
  constructor(private readonly db: Db) {}

  /** `id` is supplied when adopting a folder from disk, to preserve identity. */
  create(input: {
    classId: string
    title: string
    dirPath: string
    recordedAt: string
    status?: LectureStatus
    id?: string
    statusDetail?: string | null
  }): LectureRecord {
    const ts = nowIso()
    const row: LectureRow = {
      id: input.id ?? randomUUID(),
      class_id: input.classId,
      title: input.title,
      dir_path: input.dirPath,
      recorded_at: input.recordedAt,
      duration_sec: 0,
      status: input.status ?? 'recording',
      status_detail: input.statusDetail ?? null,
      transcript_source: null,
      transcript_pass: null,
      segment_count: 0,
      corrupt_segment_count: 0,
      created_at: ts,
      updated_at: ts
    }
    this.db
      .prepare(
        `INSERT INTO lectures (id, class_id, title, dir_path, recorded_at, duration_sec, status,
                               status_detail, transcript_source, transcript_pass, segment_count,
                               corrupt_segment_count, created_at, updated_at)
         VALUES (@id, @class_id, @title, @dir_path, @recorded_at, @duration_sec, @status,
                 @status_detail, @transcript_source, @transcript_pass, @segment_count,
                 @corrupt_segment_count, @created_at, @updated_at)`
      )
      .run(row)
    return toLecture(row)
  }

  get(id: string): LectureRecord | null {
    const row = this.db.prepare('SELECT * FROM lectures WHERE id = ?').get(id) as LectureRow | undefined
    return row ? toLecture(row) : null
  }

  listByClass(classId: string): LectureRecord[] {
    return (
      this.db.prepare('SELECT * FROM lectures WHERE class_id = ? ORDER BY recorded_at DESC').all(classId) as LectureRow[]
    ).map(toLecture)
  }

  listAll(): LectureRecord[] {
    return (this.db.prepare('SELECT * FROM lectures ORDER BY recorded_at DESC').all() as LectureRow[]).map(toLecture)
  }

  /** Lectures whose audio survived but whose transcript did not. */
  listNeedingTranscription(): LectureRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM lectures WHERE status IN ('needs_transcription','transcribing','assembling') ORDER BY recorded_at DESC`)
        .all() as LectureRow[]
    ).map(toLecture)
  }

  setStatus(id: string, status: LectureStatus, detail: string | null = null): void {
    this.db
      .prepare('UPDATE lectures SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?')
      .run(status, detail, nowIso(), id)
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        LectureRecord,
        | 'title'
        | 'dirPath'
        | 'durationSec'
        | 'status'
        | 'statusDetail'
        | 'transcriptSource'
        | 'transcriptPass'
        | 'segmentCount'
        | 'corruptSegmentCount'
      >
    >
  ): void {
    const existing = this.get(id)
    if (!existing) throw new Error(`No such lecture: ${id}`)
    const merged = { ...existing, ...patch }
    this.db
      .prepare(
        `UPDATE lectures SET title = ?, dir_path = ?, duration_sec = ?, status = ?, status_detail = ?,
                             transcript_source = ?, transcript_pass = ?, segment_count = ?,
                             corrupt_segment_count = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        merged.title,
        merged.dirPath,
        merged.durationSec,
        merged.status,
        merged.statusDetail,
        merged.transcriptSource,
        merged.transcriptPass,
        merged.segmentCount,
        merged.corruptSegmentCount,
        nowIso(),
        id
      )
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM lectures WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM lecture_search WHERE lecture_id = ?').run(id)
  }

  /** Move a lecture to a different class. Folder moves are the caller's job. */
  reassignClass(id: string, classId: string): void {
    this.db
      .prepare('UPDATE lectures SET class_id = ?, updated_at = ? WHERE id = ?')
      .run(classId, new Date().toISOString(), id)
  }

  indexForSearch(lectureId: string, className: string, title: string, body: string): void {
    this.db.prepare('DELETE FROM lecture_search WHERE lecture_id = ?').run(lectureId)
    this.db
      .prepare('INSERT INTO lecture_search (lecture_id, class_name, title, body) VALUES (?, ?, ?, ?)')
      .run(lectureId, className, title, body)
  }

  search(query: string, limit = 50): { lectureId: string; snippet: string }[] {
    const trimmed = query.trim()
    if (!trimmed) return []
    // Quote the term so FTS5 treats user punctuation as literal text rather
    // than as query syntax (a bare `C++` is a syntax error otherwise).
    const fts = trimmed
      .split(/\s+/)
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' ')
    try {
      return this.db
        .prepare(
          `SELECT lecture_id AS lectureId, snippet(lecture_search, 3, '[', ']', '…', 12) AS snippet
           FROM lecture_search WHERE lecture_search MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(fts, limit) as { lectureId: string; snippet: string }[]
    } catch {
      return []
    }
  }
}

// --- segments --------------------------------------------------------------

export class SegmentRepo {
  constructor(private readonly db: Db) {}

  add(input: Omit<SegmentRecord, 'id' | 'createdAt'>): SegmentRecord {
    const row: SegmentRow = {
      id: randomUUID(),
      lecture_id: input.lectureId,
      idx: input.index,
      rel_path: input.relPath,
      start_sec: input.startSec,
      duration_sec: input.durationSec,
      byte_length: input.byteLength,
      sha256: input.sha256,
      verified: input.verified,
      created_at: nowIso()
    }
    this.db
      .prepare(
        `INSERT INTO segments (id, lecture_id, idx, rel_path, start_sec, duration_sec, byte_length, sha256, verified, created_at)
         VALUES (@id, @lecture_id, @idx, @rel_path, @start_sec, @duration_sec, @byte_length, @sha256, @verified, @created_at)`
      )
      .run(row)
    return toSegment(row)
  }

  listByLecture(lectureId: string): SegmentRecord[] {
    return (
      this.db.prepare('SELECT * FROM segments WHERE lecture_id = ? ORDER BY idx').all(lectureId) as SegmentRow[]
    ).map(toSegment)
  }

  setVerification(id: string, verified: SegmentVerification): void {
    this.db.prepare('UPDATE segments SET verified = ? WHERE id = ?').run(verified, id)
  }
}

// --- glossary --------------------------------------------------------------

export class GlossaryRepo {
  constructor(private readonly db: Db) {}

  add(classId: string, term: string, note: string | null = null): GlossaryTerm {
    const row: GlossaryRow = {
      id: randomUUID(),
      class_id: classId,
      term: term.trim(),
      note,
      created_at: nowIso()
    }
    this.db
      .prepare(
        `INSERT INTO glossary_terms (id, class_id, term, note, created_at)
         VALUES (@id, @class_id, @term, @note, @created_at)
         ON CONFLICT(class_id, term) DO UPDATE SET note = excluded.note`
      )
      .run(row)
    const saved = this.db
      .prepare('SELECT * FROM glossary_terms WHERE class_id = ? AND term = ?')
      .get(classId, row.term) as GlossaryRow
    return toGlossary(saved)
  }

  listByClass(classId: string): GlossaryTerm[] {
    return (
      this.db
        .prepare('SELECT * FROM glossary_terms WHERE class_id = ? ORDER BY term COLLATE NOCASE')
        .all(classId) as GlossaryRow[]
    ).map(toGlossary)
  }

  update(id: string, patch: { term?: string; note?: string | null }): void {
    const row = this.db.prepare('SELECT * FROM glossary_terms WHERE id = ?').get(id) as GlossaryRow | undefined
    if (!row) throw new Error(`No such glossary term: ${id}`)
    this.db
      .prepare('UPDATE glossary_terms SET term = ?, note = ? WHERE id = ?')
      .run(patch.term?.trim() ?? row.term, patch.note === undefined ? row.note : patch.note, id)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM glossary_terms WHERE id = ?').run(id)
  }

  replaceAll(classId: string, terms: { term: string; note: string | null }[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM glossary_terms WHERE class_id = ?').run(classId)
      for (const t of terms) {
        if (!t.term.trim()) continue
        this.add(classId, t.term, t.note)
      }
    })
    tx()
  }
}

export interface Repos {
  classes: ClassRepo
  lectures: LectureRepo
  segments: SegmentRepo
  glossary: GlossaryRepo
}

export function createRepos(db: Db): Repos {
  return {
    classes: new ClassRepo(db),
    lectures: new LectureRepo(db),
    segments: new SegmentRepo(db),
    glossary: new GlossaryRepo(db)
  }
}
