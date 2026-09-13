/**
 * SQLite index over the on-disk library.
 *
 * The database is deliberately *not* the source of truth — every row here can
 * be reconstructed from `class.json` / `lecture.json` / `segments.json` on
 * disk (see `rescan.ts`). That is why losing or deleting the DB file is
 * recoverable, and why writes to disk always happen before the matching DB
 * write, never after.
 */

import Database from 'better-sqlite3'
import type { Database as Db } from 'better-sqlite3'
import * as path from 'node:path'
import * as fs from 'node:fs'

export type { Db }

export const SCHEMA_VERSION = 2

export function openDatabase(userDataDir: string): Db {
  fs.mkdirSync(userDataDir, { recursive: true })
  const db = new Database(path.join(userDataDir, 'recture.db'))

  // WAL keeps readers unblocked while a recording session writes segment rows;
  // NORMAL sync is safe under WAL and avoids an fsync on every insert.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0
  if (current >= SCHEMA_VERSION) return

  if (current < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS classes (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        dir_path    TEXT NOT NULL,
        instructor  TEXT,
        color       TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lectures (
        id                    TEXT PRIMARY KEY,
        class_id              TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        title                 TEXT NOT NULL,
        dir_path              TEXT NOT NULL,
        recorded_at           TEXT NOT NULL,
        duration_sec          REAL NOT NULL DEFAULT 0,
        status                TEXT NOT NULL,
        status_detail         TEXT,
        transcript_source     TEXT,
        transcript_pass       TEXT,
        segment_count         INTEGER NOT NULL DEFAULT 0,
        corrupt_segment_count INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lectures_class ON lectures(class_id, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_lectures_status ON lectures(status);

      CREATE TABLE IF NOT EXISTS glossary_terms (
        id         TEXT PRIMARY KEY,
        class_id   TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
        term       TEXT NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(class_id, term)
      );

      CREATE TABLE IF NOT EXISTS segments (
        id           TEXT PRIMARY KEY,
        lecture_id   TEXT NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
        idx          INTEGER NOT NULL,
        rel_path     TEXT NOT NULL,
        start_sec    REAL NOT NULL,
        duration_sec REAL NOT NULL,
        byte_length  INTEGER NOT NULL,
        sha256       TEXT NOT NULL,
        verified     TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL,
        UNIQUE(lecture_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_segments_lecture ON segments(lecture_id, idx);

      -- Full-text search over finished transcripts, one row per lecture.
      CREATE VIRTUAL TABLE IF NOT EXISTS lecture_search USING fts5(
        lecture_id UNINDEXED,
        class_name,
        title,
        body
      );
    `)
  }

  if (current < 2) {
    // One row per passage, so a search can jump to the moment something was
    // said. Transcripts indexed before this are re-indexed from disk at startup.
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS segment_search USING fts5(
        lecture_id UNINDEXED,
        segment_id UNINDEXED,
        start_sec UNINDEXED,
        text
      );
    `)
  }

  db.pragma(`user_version = ${SCHEMA_VERSION}`)
}
