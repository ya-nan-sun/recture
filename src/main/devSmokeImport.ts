/**
 * Integration checks for importing audio files and for how a lecture's audio
 * is kept once transcribed: one checksummed WAV or Opus file, retryable,
 * extendable, rebuildable from disk. Real ffmpeg, real SQLite, real files; only
 * the speech-to-text provider is stubbed.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AppSettings, ImportProgress } from '@shared/types'
import { IPC } from '@shared/ipc'
import { createClass, createLecture, recoverAllInterrupted } from './library'
import { RecordingController } from './recordingController'
import { rescanLibrary } from './rescan'
import { runFfmpeg } from './audio/ffmpeg'
import { verifyArchiveFile } from './audio/archive'
import type { SegmentManifest } from './audio/recordingSession'
import { lecturePaths, readJson } from './storage/paths'
import { testSettings, type SmokeContext } from './devSmokePipeline'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) return false
    await wait(20)
  }
  return true
}

async function exists(target: string): Promise<boolean> {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false)
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function runImportAndStorageChecks(ctx: SmokeContext): Promise<void> {
  const { repos, root, check, frame, stubTranscriber } = ctx
  const settings: AppSettings = { ...testSettings(root), segmentSeconds: 1 }
  const klass = await createClass(repos, root, { name: 'ECON 1010 Markets' })
  const progress: ImportProgress[] = []

  const controller = new RecordingController({
    repos,
    getSettings: () => settings,
    getApiKey: () => null,
    getTranscriber: () => stubTranscriber(),
    broadcast: (channel, payload) => {
      if (channel === IPC.evtImportProgress) progress.push(payload as ImportProgress)
    }
  })

  const statusOf = (id: string): string => String(repos.lectures.get(id)?.status)
  const detailOf = (id: string): string => String(repos.lectures.get(id)?.statusDetail)
  const phaseSeen = (id: string, phase: ImportProgress['phase']): boolean =>
    progress.some((p) => p.lectureId === id && p.phase === phase)
  const archiveOf = async (id: string) => {
    const lecture = repos.lectures.get(id)
    const manifest = lecture ? await readJson<SegmentManifest>(lecturePaths(lecture.dirPath).manifest) : null
    return manifest?.archive ?? null
  }
  const audioFiles = async (id: string): Promise<string[]> =>
    (await fs.readdir(lecturePaths(repos.lectures.get(id)!.dirPath).audioDir)).sort()
  const archiveVerifies = async (id: string): Promise<boolean> => {
    const lecture = repos.lectures.get(id)
    const archive = await archiveOf(id)
    if (!lecture || !archive) return false
    return (await verifyArchiveFile(path.join(lecture.dirPath, ...archive.relPath.split('/')), archive)).ok
  }
  const transcribeAgain = async (id: string): Promise<void> => {
    controller.requestTranscription(id, 'retry')
    await waitFor(() => !controller.queue.has(id))
  }

  const fixtures = path.join(path.dirname(root), 'fixtures')
  await fs.mkdir(fixtures, { recursive: true })
  const memo = path.join(fixtures, 'Week 7 voice memo.m4a')
  await runFfmpeg(['-nostats', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=3.3', '-ac', '2', '-c:a', 'aac', memo])

  // --- import, transcribe, compact -----------------------------------------
  const imported = await controller.importAudio(klass, memo)
  check('importing creates a lecture named after the file', imported.title === 'Week 7 voice memo', imported.title)
  check('a lecture being imported says so', imported.status === 'importing', imported.status)

  // "complete" is set once the transcript is saved; folding the audio into one
  // file follows in the same job, so wait for the job itself to finish.
  await waitFor(() => statusOf(imported.id) === 'complete' && !controller.queue.has(imported.id))
  check('an imported file is transcribed like a recording', statusOf(imported.id) === 'complete', `${statusOf(imported.id)}: ${detailOf(imported.id)}`)
  check('import progress is reported through to the end', phaseSeen(imported.id, 'importing') && phaseSeen(imported.id, 'done'))

  const wavArchive = await archiveOf(imported.id)
  check('an imported file keeps its full length', Math.abs((wavArchive?.durationSec ?? 0) - 3.3) < 0.15, String(wavArchive?.durationSec))
  check('after transcription the audio is one checksummed file', await archiveVerifies(imported.id))
  const filesAfter = await audioFiles(imported.id)
  check(
    'no redundant copies of the audio are left behind',
    filesAfter.length === 2 && filesAfter.some((f) => /^lecture-[0-9a-f]+\.wav$/.test(f)),
    filesAfter.join(', ')
  )
  check('segment rows are cleared once folded into the file', repos.segments.listByLecture(imported.id).length === 0)

  // --- a compacted lecture can be transcribed again -------------------------
  await transcribeAgain(imported.id)
  check('a compacted lecture can be transcribed again', statusOf(imported.id) === 'complete', `${statusOf(imported.id)}: ${detailOf(imported.id)}`)
  const retried = await archiveOf(imported.id)
  check(
    're-transcribing keeps exactly the same audio file',
    retried?.sha256 === wavArchive?.sha256 && (await audioFiles(imported.id)).length === 2
  )

  // --- compressed storage ----------------------------------------------------
  settings.audioStorage = 'opus'
  await transcribeAgain(imported.id)
  const opusArchive = await archiveOf(imported.id)
  check(
    'compressed storage keeps the lecture as Opus',
    opusArchive?.format === 'opus' && (await archiveVerifies(imported.id)),
    JSON.stringify(opusArchive)
  )
  check(
    'compressed audio takes a fraction of the space',
    (opusArchive?.byteLength ?? Infinity) < (wavArchive?.byteLength ?? 0) / 4,
    `${opusArchive?.byteLength} vs ${wavArchive?.byteLength} bytes`
  )
  check(
    'the WAV is removed once the Opus file is verified',
    !(await audioFiles(imported.id)).some((f) => f.endsWith('.wav')),
    (await audioFiles(imported.id)).join(', ')
  )
  await transcribeAgain(imported.id)
  check(
    'a compressed lecture can be transcribed again',
    statusOf(imported.id) === 'complete' && (await archiveOf(imported.id))?.format === 'opus',
    `${statusOf(imported.id)}: ${detailOf(imported.id)}`
  )
  settings.audioStorage = 'wav'

  // --- recording more into a compacted lecture ------------------------------
  await controller.start(klass, repos.lectures.get(imported.id)!)
  const offset = controller.getState().offsetSec
  for (let i = 0; i < 12; i++) controller.writeAudio(toArrayBuffer(frame(100)))
  await controller.stop()
  await waitFor(() => !controller.queue.has(imported.id))
  const extended = await archiveOf(imported.id)
  check(
    'recording into a compacted lecture continues after its audio',
    Math.abs(offset - (opusArchive?.durationSec ?? -1)) < 0.01,
    `${offset} vs ${opusArchive?.durationSec}`
  )
  check(
    'the new recording is folded in with the imported audio',
    statusOf(imported.id) === 'complete' &&
      extended?.format === 'wav' &&
      Math.abs((extended?.durationSec ?? 0) - ((opusArchive?.durationSec ?? 0) + 1.2)) < 0.15,
    JSON.stringify(extended)
  )

  // --- rebuilding from disk ---------------------------------------------------
  repos.lectures.delete(imported.id)
  await rescanLibrary(repos, root)
  check(
    'a compacted lecture is rebuilt from disk',
    statusOf(imported.id) === 'complete' && (await archiveVerifies(imported.id)),
    statusOf(imported.id)
  )

  // --- damage is flagged, never deleted ----------------------------------------
  const damaged = repos.lectures.get(imported.id)!
  const damagedArchive = (await archiveOf(imported.id))!
  const damagedPath = path.join(damaged.dirPath, ...damagedArchive.relPath.split('/'))
  const handle = await fs.open(damagedPath, 'r+')
  await handle.write(Buffer.from([0x5a, 0xa5]), 0, 2, 2000)
  await handle.close()
  await transcribeAgain(imported.id)
  check(
    'a damaged lecture audio file is flagged for attention',
    statusOf(imported.id) === 'needs_attention' && /integrity/.test(detailOf(imported.id)),
    `${statusOf(imported.id)}: ${detailOf(imported.id)}`
  )
  check('a damaged lecture audio file is kept, not deleted', await exists(damagedPath))

  // --- a file that is not audio ----------------------------------------------
  const bogus = path.join(fixtures, 'not audio.mp3')
  await fs.writeFile(bogus, 'These are my notes, not a recording.\n'.repeat(200))
  const bad = await controller.importAudio(klass, bogus)
  await waitFor(() => phaseSeen(bad.id, 'failed'))
  const failure = progress.find((p) => p.lectureId === bad.id && p.phase === 'failed')
  check(
    'importing a file that is not audio explains why',
    /isn't audio|doesn't contain any audio/.test(failure?.message ?? ''),
    failure?.message
  )
  check(
    'a failed import leaves no half-made lecture behind',
    repos.lectures.get(bad.id) === null && !(await exists(bad.dirPath))
  )

  // --- cancelling ---------------------------------------------------------------
  const long = path.join(fixtures, 'Long lecture.mp3')
  await runFfmpeg(['-nostats', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=44100:duration=120', long])
  const running = await controller.importAudio(klass, long)
  const waiting = await controller.importAudio(klass, memo)
  check('a second import waits its turn', phaseSeen(waiting.id, 'waiting') && statusOf(waiting.id) === 'importing')

  await waitFor(() => phaseSeen(running.id, 'importing'))
  await controller.cancelImport(waiting.id)
  check(
    'cancelling a waiting import removes its lecture',
    repos.lectures.get(waiting.id) === null && !(await exists(waiting.dirPath)) && phaseSeen(waiting.id, 'cancelled')
  )
  await controller.cancelImport(running.id)
  check(
    'cancelling a running import stops it and removes the partial lecture',
    repos.lectures.get(running.id) === null && !(await exists(running.dirPath)) && phaseSeen(running.id, 'cancelled')
  )
  check('the source file is never touched', await exists(long))

  // --- a crash in the middle of an import -------------------------------------
  const crashed = await createLecture(repos, klass, { title: 'Crashed import' })
  repos.lectures.setStatus(crashed.id, 'importing', null)
  await recoverAllInterrupted(repos)
  check(
    'an import interrupted by a crash is flagged on the next launch',
    statusOf(crashed.id) === 'needs_attention' && /import/i.test(detailOf(crashed.id)),
    `${statusOf(crashed.id)}: ${detailOf(crashed.id)}`
  )

  await controller.shutdown()
}
