/**
 * Dev-only end-to-end check of the main-process pipeline.
 *
 * Runs inside Electron because better-sqlite3 is built for Electron's ABI and
 * cannot be loaded by the plain-Node test runner. Everything here uses the
 * real code paths — real WAV writes, real checksums, real SQLite, real
 * assembly, real exports — with only the STT provider stubbed, since that is
 * the one part that needs a network or a model download.
 *
 *   npm run smoke
 */

import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { TranscriptFile } from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { openDatabase } from './db/database'
import { createRepos } from './db/repos'
import {
  createClass,
  createLecture,
  deleteClass,
  deleteLecture,
  moveLecture,
  recoverInterruptedLecture,
  renameClass,
  renameLecture,
  syncGlossaryToDisk
} from './library'
import { RecordingSession } from './audio/recordingSession'
import { lecturePaths, readJson } from './storage/paths'
import { WavSegmentWriter } from './audio/wav'
import { handleFinalPassFailure, runFinalPass } from './transcription/pipeline'
import { PermanentTranscriptionError, TransientTranscriptionError, type BatchTranscriber } from './transcription/types'
import { rescanLibrary, reportIsEmpty } from './rescan'
import { transcriptToMarkdown } from './export/markdown'
import { transcriptToPdf } from './export/pdf'
import { runRecordingPipelineChecks } from './devSmokePipeline'

const results: { name: string; ok: boolean; detail?: string }[] = []

function check(name: string, condition: boolean, detail?: string): void {
  results.push({ name, ok: condition, detail })
}

/** 16-bit PCM frame of a quiet tone, `ms` long. */
function frame(ms: number): Buffer {
  const samples = Math.round((16000 * ms) / 1000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(6000 * Math.sin(i / 12)), i * 2)
  return buf
}

/** Stub provider returning a transcript with a deliberately misheard term. */
function stubTranscriber(): BatchTranscriber {
  return {
    id: 'whisper-local',
    label: 'stub',
    sendsAudioOffDevice: false,
    checkAvailability: async () => ({ id: 'whisper-local', available: true, detail: 'stub', sendsAudioOffDevice: false }),
    transcribe: async () => ({
      provider: 'stub',
      model: 'stub-1',
      language: 'en',
      durationSec: 3.5,
      segments: [
        {
          id: randomUUID(),
          start: 0,
          end: 3.5,
          speaker: 'Speaker 1',
          // "eigen value" should be flagged against the glossary; "the" must not be.
          text: 'the eigen value of the matrix is what we want',
          words: 'the eigen value of the matrix is what we want'.split(' ').map((word, i) => ({
            word,
            start: i * 0.35,
            end: (i + 1) * 0.35,
            confidence: word === 'eigen' || word === 'value' ? 0.42 : 0.97
          }))
        }
      ]
    })
  }
}

function failingTranscriber(): BatchTranscriber {
  return {
    ...stubTranscriber(),
    transcribe: async () => {
      throw new TransientTranscriptionError('simulated outage')
    }
  }
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-smoke-'))
  app.setPath('userData', path.join(tmp, 'userData'))

  const root = path.join(tmp, 'library')
  const db = openDatabase(path.join(tmp, 'userData'))
  const repos = createRepos(db)

  // --- 1. class + lecture on disk -----------------------------------------
  const klass = await createClass(repos, root, { name: 'CS 4501: Machine Learning' })
  check('class folder is created with a sanitized name', klass.name === 'CS 4501 Machine Learning', klass.name)
  check('glossary.json is written', await exists(path.join(klass.dirPath, 'glossary.json')))

  repos.glossary.add(klass.id, 'eigenvalue', 'linear algebra')
  repos.glossary.add(klass.id, 'Nyquist', null)
  await syncGlossaryToDisk(repos, klass)

  const lecture = await createLecture(repos, klass, { title: 'Week 3 — Spectral methods' })
  check('lecture folder is created', await exists(lecture.dirPath), lecture.dirPath)

  // --- 2. record audio -----------------------------------------------------
  const session = new RecordingSession({
    lectureId: lecture.id,
    lectureDir: lecture.dirPath,
    segmentSeconds: 1,
    onSegmentComplete: (entry) =>
      repos.segments.add({
        lectureId: lecture.id,
        index: entry.index,
        relPath: entry.relPath,
        startSec: entry.startSec,
        durationSec: entry.durationSec,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        verified: 'pending'
      })
  })
  await session.start()
  for (let i = 0; i < 35; i++) session.write(frame(100)) // 3.5 s
  await session.stop()

  const segments = repos.segments.listByLecture(lecture.id)
  check('audio rolled into 4 segments', segments.length === 4, `got ${segments.length}`)
  check(
    'every segment has a checksum',
    segments.every((s) => /^[0-9a-f]{64}$/.test(s.sha256))
  )
  check('no audio was lost', segments.reduce((n, s) => n + s.durationSec, 0) > 3.4)

  // --- 3. final pass -------------------------------------------------------
  const settings = {
    language: 'en',
    correctionConfidenceThreshold: 0.85,
    correctionSimilarityThreshold: 0.74
  } as never

  const { transcript } = await runFinalPass(klass, repos.lectures.get(lecture.id)!, {
    repos,
    settings,
    transcriber: stubTranscriber(),
    glossary: repos.glossary.listByClass(klass.id),
    onProgress: () => undefined
  })

  check('final.wav was assembled', await exists(lecturePaths(lecture.dirPath).finalAudio))
  check('transcript.json was written', await exists(lecturePaths(lecture.dirPath).transcript))
  check('transcript is marked as a final pass', transcript.source.pass === 'final')
  check('lecture is complete', repos.lectures.get(lecture.id)!.status === 'complete')

  const suggested = transcript.suggestions.map((s) => `${s.original}->${s.suggested}`)
  check(
    'misheard glossary term is flagged',
    transcript.suggestions.some((s) => s.suggested === 'eigenvalue'),
    suggested.join(', ') || 'none'
  )
  check(
    'nothing is auto-applied',
    transcript.suggestions.every((s) => s.status === 'pending')
  )
  check(
    'ordinary words are not rewritten',
    !transcript.suggestions.some((s) => s.original.trim() === 'the'),
    suggested.join(', ')
  )

  // --- 4. search index -----------------------------------------------------
  check('transcript is searchable', repos.lectures.search('matrix').some((h) => h.lectureId === lecture.id))

  // --- 5. exports ----------------------------------------------------------
  const md = transcriptToMarkdown(transcript, DEFAULT_EXPORT_OPTIONS)
  check('markdown carries the class header', md.includes('CS 4501 Machine Learning'))
  const pdf = await transcriptToPdf(transcript, DEFAULT_EXPORT_OPTIONS)
  check('pdf is well-formed', Buffer.from(pdf.subarray(0, 5)).toString('ascii') === '%PDF-')

  // --- 6. corrupt segment is excluded, not ignored -------------------------
  const lectureB = await createLecture(repos, klass, { title: 'Week 4' })
  const sessionB = new RecordingSession({
    lectureId: lectureB.id,
    lectureDir: lectureB.dirPath,
    segmentSeconds: 1,
    onSegmentComplete: (entry) =>
      repos.segments.add({
        lectureId: lectureB.id,
        index: entry.index,
        relPath: entry.relPath,
        startSec: entry.startSec,
        durationSec: entry.durationSec,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        verified: 'pending'
      })
  })
  await sessionB.start()
  for (let i = 0; i < 25; i++) sessionB.write(frame(100))
  await sessionB.stop()

  // Corrupt the second segment on disk, the way bit-rot or a bad write would.
  const victim = repos.segments.listByLecture(lectureB.id)[1]!
  const victimPath = path.join(lectureB.dirPath, ...victim.relPath.split('/'))
  const handle = await fs.open(victimPath, 'r+')
  await handle.write(Buffer.from([0xde, 0xad]), 0, 2, 60)
  await handle.close()

  const resultB = await runFinalPass(klass, repos.lectures.get(lectureB.id)!, {
    repos,
    settings,
    transcriber: stubTranscriber(),
    glossary: repos.glossary.listByClass(klass.id),
    onProgress: () => undefined
  })

  check('corrupt segment is detected', resultB.corruptSegments.length === 1, JSON.stringify(resultB.corruptSegments))
  check(
    'corrupt segment is recorded in the transcript',
    resultB.transcript.excludedAudioSegments.length === 1
  )
  check('lecture is flagged for attention', repos.lectures.get(lectureB.id)!.status === 'needs_attention')
  check('corrupt segment file is left on disk', await exists(victimPath))

  // --- 7. failed final pass keeps the audio --------------------------------
  const lectureC = await createLecture(repos, klass, { title: 'Week 5' })
  const sessionC = new RecordingSession({
    lectureId: lectureC.id,
    lectureDir: lectureC.dirPath,
    segmentSeconds: 1,
    onSegmentComplete: (entry) =>
      repos.segments.add({
        lectureId: lectureC.id,
        index: entry.index,
        relPath: entry.relPath,
        startSec: entry.startSec,
        durationSec: entry.durationSec,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        verified: 'pending'
      })
  })
  await sessionC.start()
  for (let i = 0; i < 15; i++) sessionC.write(frame(100))
  await sessionC.stop()
  const segmentsBefore = repos.segments.listByLecture(lectureC.id).length

  try {
    await runFinalPass(klass, repos.lectures.get(lectureC.id)!, {
      repos,
      settings,
      transcriber: failingTranscriber(),
      glossary: [],
      onProgress: () => undefined
    })
    check('failing transcription throws', false, 'it did not throw')
  } catch (err) {
    await handleFinalPassFailure(repos, repos.lectures.get(lectureC.id)!, err as Error, () => undefined)
  }

  const afterFailure = repos.lectures.get(lectureC.id)!
  check('failed lecture is marked needs_transcription', afterFailure.status === 'needs_transcription', afterFailure.status)
  check('audio survives a failed transcription', repos.segments.listByLecture(lectureC.id).length === segmentsBefore)
  check(
    'every surviving segment still verifies',
    (
      await Promise.all(
        repos.segments
          .listByLecture(lectureC.id)
          .map((s) => exists(path.join(lectureC.dirPath, ...s.relPath.split('/'))))
      )
    ).every(Boolean)
  )

  // --- 8. crash recovery ---------------------------------------------------
  const lectureD = await createLecture(repos, klass, { title: 'Week 6 (crashed)' })
  const sessionD = new RecordingSession({
    lectureId: lectureD.id,
    lectureDir: lectureD.dirPath,
    segmentSeconds: 1
  })
  await sessionD.start()
  for (let i = 0; i < 22; i++) sessionD.write(frame(100))
  await sessionD.flush()
  // Simulate the process dying: abandon the open segment, never close the
  // manifest, leave the lecture in `recording`.
  await sessionD.abort()

  const recovery = await recoverInterruptedLecture(repos, repos.lectures.get(lectureD.id)!)
  check('crash recovery finds the completed segments', recovery.recoveredSegments >= 2, JSON.stringify(recovery))
  check('crash recovery repairs the partial segment', recovery.repairedPartial, JSON.stringify(recovery))
  check(
    'recovered lecture is ready to transcribe',
    repos.lectures.get(lectureD.id)!.status === 'needs_transcription'
  )

  // --- 9. rename / move / delete ------------------------------------------
  const renamed = await renameLecture(repos, klass, repos.lectures.get(lecture.id)!, 'Week 3 renamed')
  check('lecture rename moves the folder', await exists(renamed.dirPath) && renamed.dirPath !== lecture.dirPath)
  check('old lecture folder is gone', !(await exists(lecture.dirPath)))
  check('audio survives a rename', await exists(lecturePaths(renamed.dirPath).finalAudio))
  const renamedTranscript = await readJson<TranscriptFile>(lecturePaths(renamed.dirPath).transcript)
  check('transcript title follows the rename', renamedTranscript?.lectureTitle === 'Week 3 renamed', String(renamedTranscript?.lectureTitle))

  const other = await createClass(repos, root, { name: 'MATH 3250 Linear Algebra' })
  const moved = await moveLecture(repos, repos.lectures.get(lecture.id)!, other)
  check('lecture move relocates the folder', await exists(moved.dirPath))
  check('moved lecture belongs to the new class', repos.lectures.get(lecture.id)!.classId === other.id)
  check('audio survives a move', await exists(lecturePaths(moved.dirPath).finalAudio))
  const movedTranscript = await readJson<TranscriptFile>(lecturePaths(moved.dirPath).transcript)
  check('transcript class follows the move', movedTranscript?.className === other.name, String(movedTranscript?.className))
  // Move it back so the class rename below still covers a populated class.
  await moveLecture(repos, repos.lectures.get(lecture.id)!, repos.classes.get(klass.id)!)

  const renamedClass = await renameClass(repos, root, repos.classes.get(klass.id)!, 'CS 4501 Advanced ML')
  check('class rename moves the folder', await exists(renamedClass.dirPath))
  check(
    'lectures follow a class rename',
    repos.lectures.listByClass(klass.id).every((l) => l.dirPath.startsWith(renamedClass.dirPath)),
    repos.lectures.listByClass(klass.id).map((l) => l.dirPath).join(' | ')
  )
  check(
    'audio survives a class rename',
    await exists(lecturePaths(repos.lectures.get(lecture.id)!.dirPath).finalAudio)
  )

  // Default delete keeps every byte on disk.
  const keepDir = repos.lectures.get(lectureC.id)!.dirPath
  const kept = await deleteLecture(repos, root, repos.lectures.get(lectureC.id)!, false)
  check('remove-from-library leaves the files alone', (await exists(keepDir)) && !kept.filesDeleted)
  check('removed lecture is out of the index', repos.lectures.get(lectureC.id) === null)

  // Opt-in delete really erases.
  const doomedDir = repos.lectures.get(lectureB.id)!.dirPath
  const erased = await deleteLecture(repos, root, repos.lectures.get(lectureB.id)!, true)
  check('opt-in delete erases the folder', !(await exists(doomedDir)) && erased.filesDeleted)

  // Deleting outside the library root is refused even if the DB says otherwise.
  const escapee = repos.lectures.get(lectureD.id)!
  repos.lectures.update(escapee.id, { dirPath: path.join(os.tmpdir(), 'definitely-not-the-library') })
  let refused = false
  try {
    await deleteLecture(repos, root, repos.lectures.get(lectureD.id)!, true)
  } catch {
    refused = true
  }
  check('delete outside the library root is refused', refused)

  const classDir = repos.classes.get(other.id)!.dirPath
  const classGone = await deleteClass(repos, root, repos.classes.get(other.id)!, false)
  check('class removal keeps its folder by default', (await exists(classDir)) && !classGone.filesDeleted)
  check('removed class is out of the index', repos.classes.get(other.id) === null)

  // --- 10. transcript.json is the only export source -----------------------
  const onDisk = await readJson<TranscriptFile>(lecturePaths(repos.lectures.get(lecture.id)!.dirPath).transcript)
  check('transcript.json round-trips', onDisk !== null && onDisk.segments.length === transcript.segments.length)

  // --- 11. disk <-> index reconciliation -----------------------------------
  const syncClass = await createClass(repos, root, { name: 'PHYS 2010 Mechanics' })
  const syncLecture = await createLecture(repos, syncClass, { title: 'Week 1' })
  const sessionE = new RecordingSession({
    lectureId: syncLecture.id,
    lectureDir: syncLecture.dirPath,
    segmentSeconds: 1
  })
  await sessionE.start()
  for (let i = 0; i < 12; i++) sessionE.write(frame(100))
  await sessionE.stop()

  // Settle first: earlier checks deliberately left the index inconsistent
  // (one row's dirPath is corrupted on purpose), and repairing that is exactly
  // rescan's job. The property worth asserting is idempotence.
  await rescanLibrary(repos, root)
  check('a second rescan changes nothing', reportIsEmpty(await rescanLibrary(repos, root)))

  // Rename a class folder the way Explorer would.
  const beforeDir = repos.classes.get(syncClass.id)!.dirPath
  const afterDir = path.join(path.dirname(beforeDir), 'PHYS 2010 Classical Mechanics')
  await fs.rename(beforeDir, afterDir)
  await rescanLibrary(repos, root)
  check(
    'a class folder renamed on disk is followed, not duplicated',
    repos.classes.get(syncClass.id)?.name === 'PHYS 2010 Classical Mechanics',
    String(repos.classes.get(syncClass.id)?.name)
  )
  check(
    'lectures follow their renamed class folder',
    repos.lectures.get(syncLecture.id)?.dirPath.startsWith(afterDir) === true
  )

  // Move a lecture between classes in the filesystem.
  const targetClass = repos.classes.get(klass.id)!
  const draggedTo = path.join(targetClass.dirPath, path.basename(repos.lectures.get(syncLecture.id)!.dirPath))
  await fs.rename(repos.lectures.get(syncLecture.id)!.dirPath, draggedTo)
  await rescanLibrary(repos, root)
  check(
    'a lecture folder moved on disk is reassigned to its new class',
    repos.lectures.get(syncLecture.id)?.classId === targetClass.id
  )

  // Delete a lecture folder outright.
  await fs.rm(repos.lectures.get(syncLecture.id)!.dirPath, { recursive: true, force: true })
  await rescanLibrary(repos, root)
  check('deleting a lecture folder removes it from the app', repos.lectures.get(syncLecture.id) === null)

  // Delete a class folder outright.
  await fs.rm(afterDir, { recursive: true, force: true })
  await rescanLibrary(repos, root)
  check('deleting a class folder removes it from the app', repos.classes.get(syncClass.id) === null)

  // "Remove from library, keep files" must survive a rescan.
  const keepClass = await createClass(repos, root, { name: 'HIST 1000 Keepme' })
  const keepLecture = await createLecture(repos, keepClass, { title: 'Kept' })
  await deleteLecture(repos, root, keepLecture, false)
  await rescanLibrary(repos, root)
  check(
    'remove-from-library is not undone by the disk scan',
    repos.lectures.get(keepLecture.id) === null && (await exists(keepLecture.dirPath))
  )

  // The headline claim: the whole index rebuilds from disk alone.
  await rescanLibrary(repos, root)
  const classesBefore = repos.classes.list().length
  const lecturesBefore = repos.lectures.listAll().length
  for (const l of repos.lectures.listAll()) repos.lectures.delete(l.id)
  for (const c of repos.classes.list()) repos.classes.delete(c.id)
  check('index is empty after wiping it', repos.classes.list().length === 0 && repos.lectures.listAll().length === 0)

  await rescanLibrary(repos, root)
  check(
    'the library rebuilds from disk after losing the database',
    repos.classes.list().length === classesBefore && repos.lectures.listAll().length === lecturesBefore,
    `classes ${repos.classes.list().length}/${classesBefore}, lectures ${repos.lectures.listAll().length}/${lecturesBefore}`
  )
  check(
    'rebuilt lectures keep their transcripts',
    repos.lectures.listAll().some((l) => l.transcriptSource !== null)
  )

  // --- 12. recording pipeline: queue, quit and resume, pause, bookmarks ---
  await runRecordingPipelineChecks({ repos, root, check, frame, stubTranscriber })

  // --- report --------------------------------------------------------------
  const failed = results.filter((r) => !r.ok)
  const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
  lines.push('', `${results.length - failed.length}/${results.length} checks passed`)

  await fs.writeFile(process.env.SMOKE_OUT ?? path.join(tmp, 'smoke.txt'), lines.join('\n'), 'utf8')
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  app.exit(failed.length === 0 ? 0 : 1)
}

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false)
}

/** Keep a reference so the unused import lint doesn't drop these. */
void [WavSegmentWriter, PermanentTranscriptionError]

app.whenReady().then(() =>
  main().catch(async (err) => {
    await fs
      .writeFile(process.env.SMOKE_OUT ?? 'smoke.txt', `CRASHED: ${(err as Error).stack ?? String(err)}`, 'utf8')
      .catch(() => undefined)
    app.exit(1)
  })
)
