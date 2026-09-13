/**
 * Integration checks for the recording pipeline: the transcription queue,
 * back-to-back recording, stopping on quit and resuming on relaunch, recording
 * into an existing lecture, pausing, and bookmarks.
 *
 * Run from devSmoke inside Electron, against real SQLite and real audio files,
 * with only the speech-to-text provider stubbed.
 */

import type { AppSettings } from '@shared/types'
import type { Repos } from './db/repos'
import { createClass, createLecture, recoverStrandedTranscriptions } from './library'
import { RecordingController } from './recordingController'
import { readBookmarks } from './bookmarks'
import { lecturePaths, readJson } from './storage/paths'
import { TranscriptionAbortedError, type BatchTranscriber } from './transcription/types'
import type { SegmentManifest } from './audio/recordingSession'

export interface SmokeContext {
  repos: Repos
  root: string
  check: (name: string, condition: boolean, detail?: string) => void
  frame: (ms: number) => Buffer
  stubTranscriber: () => BatchTranscriber
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) return false
    await wait(20)
  }
  return true
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** A provider whose calls finish only when released, and which honours aborts. */
function gatedTranscriber(stub: () => BatchTranscriber) {
  const gates: Array<() => void> = []
  let calls = 0
  let aborted = 0
  let inFlight = 0
  let maxInFlight = 0

  const transcriber: BatchTranscriber = {
    ...stub(),
    transcribe: async (request) => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await new Promise<void>((resolve, reject) => {
          gates.push(resolve)
          request.signal?.addEventListener(
            'abort',
            () => {
              const index = gates.indexOf(resolve)
              if (index >= 0) gates.splice(index, 1)
              aborted += 1
              reject(new TranscriptionAbortedError('Transcription was stopped.'))
            },
            { once: true }
          )
        })
      } finally {
        inFlight -= 1
      }
      return stub().transcribe(request)
    }
  }

  return {
    transcriber,
    releaseNext: (): void => gates.shift()?.(),
    pending: (): number => gates.length,
    calls: (): number => calls,
    aborted: (): number => aborted,
    maxInFlight: (): number => maxInFlight
  }
}

function testSettings(root: string): AppSettings {
  return {
    rootDir: root,
    segmentSeconds: 1,
    liveProvider: 'none',
    batchProvider: 'whisper-local',
    deepgramLiveModel: 'nova-3',
    deepgramBatchModel: 'nova-3',
    whisperModel: 'tiny.en',
    whisperComputeType: 'int8',
    language: 'en',
    recordHotkey: '',
    bookmarkHotkey: '',
    correctionConfidenceThreshold: 0.85,
    correctionSimilarityThreshold: 0.74,
    acknowledgedCloudNotice: true
  }
}

export async function runRecordingPipelineChecks(ctx: SmokeContext): Promise<void> {
  const { repos, root, check, frame, stubTranscriber } = ctx
  const settings = testSettings(root)
  const klass = await createClass(repos, root, { name: 'BIO 1010 Cells' })

  const makeController = (transcriber: BatchTranscriber): RecordingController =>
    new RecordingController({
      repos,
      getSettings: () => settings,
      getApiKey: () => null,
      getTranscriber: () => transcriber,
      broadcast: () => undefined
    })

  const feed = (controller: RecordingController, frames: number): void => {
    for (let i = 0; i < frames; i++) controller.writeAudio(toArrayBuffer(frame(100)))
  }

  const statusOf = (id: string): string => String(repos.lectures.get(id)?.status)

  // --- back-to-back recording while the previous lecture transcribes --------
  const gate = gatedTranscriber(stubTranscriber)
  const recorder = makeController(gate.transcriber)

  const lecA = await createLecture(repos, klass, { title: 'Back to back A' })
  await recorder.start(klass, lecA)
  feed(recorder, 12)
  await recorder.stop()
  await waitFor(() => gate.pending() === 1)
  check('stopping hands the lecture to the transcription queue', recorder.queue.isRunning(lecA.id))

  const lecB = await createLecture(repos, klass, { title: 'Back to back B' })
  let backToBack = 'started'
  try {
    await recorder.start(klass, lecB)
  } catch (err) {
    backToBack = (err as Error).message
  }
  check('the next lecture can be recorded while the previous one transcribes', backToBack === 'started', backToBack)
  feed(recorder, 12)
  await recorder.stop().catch(() => undefined)
  check('the next lecture waits its turn', recorder.queue.position(lecB.id) === 1, String(recorder.queue.position(lecB.id)))
  check('a waiting lecture is marked queued', statusOf(lecB.id) === 'queued', statusOf(lecB.id))

  gate.releaseNext()
  await waitFor(() => gate.pending() === 1)
  gate.releaseNext()
  await recorder.queue.idle()
  check(
    'both back-to-back lectures finish transcribing',
    statusOf(lecA.id) === 'complete' && statusOf(lecB.id) === 'complete',
    `${statusOf(lecA.id)} / ${statusOf(lecB.id)}`
  )
  check('queued lectures transcribe one at a time', gate.maxInFlight() === 1, String(gate.maxInFlight()))

  // --- quitting mid-transcription, then resuming on the next launch ---------
  const gate2 = gatedTranscriber(stubTranscriber)
  const quitting = makeController(gate2.transcriber)
  const lecC = await createLecture(repos, klass, { title: 'Interrupted by quit' })
  await quitting.start(klass, lecC)
  feed(quitting, 12)
  await quitting.stop()
  await waitFor(() => gate2.pending() === 1)
  await quitting.shutdown()
  check('quitting stops the transcription in progress', gate2.aborted() === 1, String(gate2.aborted()))
  check(
    'an interrupted transcription keeps its place for next launch',
    statusOf(lecC.id) === 'queued',
    `${statusOf(lecC.id)}: ${repos.lectures.get(lecC.id)?.statusDetail}`
  )

  const stranded = await recoverStrandedTranscriptions(repos)
  check(
    'startup finds the interrupted transcription',
    stranded.some((l) => l.id === lecC.id),
    stranded.map((l) => l.title).join(', ')
  )

  const relaunched = makeController(stubTranscriber())
  for (const lecture of stranded) relaunched.requestTranscription(lecture.id, 'resumed')
  await relaunched.queue.idle()
  check('the interrupted lecture completes after relaunch', statusOf(lecC.id) === 'complete', statusOf(lecC.id))

  // --- recording into a lecture that already has audio ---------------------
  const lecD = await createLecture(repos, klass, { title: 'Two sittings' })
  await relaunched.start(klass, lecD)
  feed(relaunched, 12)
  await relaunched.stop()
  await relaunched.queue.idle()

  await relaunched.start(klass, repos.lectures.get(lecD.id)!)
  const resumedOffset = relaunched.getState().offsetSec
  feed(relaunched, 12)
  await relaunched.stop()
  await relaunched.queue.idle()

  const dManifest = await readJson<SegmentManifest>(lecturePaths(lecD.dirPath).manifest)
  const dIndexes = (dManifest?.segments ?? []).map((s) => s.index).join(',')
  check('recording again into a lecture adds to its audio', dIndexes === '1,2,3,4', dIndexes)
  check('the second sitting starts where the first ended', Math.abs(resumedOffset - 1.2) < 0.01, String(resumedOffset))
  check(
    'the lecture is re-transcribed with all of its audio',
    repos.segments.listByLecture(lecD.id).length === 4 && statusOf(lecD.id) === 'complete',
    `${repos.segments.listByLecture(lecD.id).length} segments, ${statusOf(lecD.id)}`
  )

  // --- pausing for a break -------------------------------------------------
  const lecE = await createLecture(repos, klass, { title: 'With a break' })
  await relaunched.start(klass, lecE)
  feed(relaunched, 5)
  await relaunched.pause()
  const whilePaused = relaunched.getState()
  feed(relaunched, 5)
  relaunched.resume()
  feed(relaunched, 5)
  await relaunched.stop()
  await relaunched.queue.idle()
  const eManifest = await readJson<SegmentManifest>(lecturePaths(lecE.dirPath).manifest)
  check('pausing shows in the recording state', whilePaused.paused && whilePaused.pausedAt !== null)
  check(
    'audio sent while paused is not recorded',
    Math.abs((eManifest?.totalDurationSec ?? 0) - 1.0) < 0.01,
    String(eManifest?.totalDurationSec)
  )

  // --- bookmarks while recording -------------------------------------------
  const lecF = await createLecture(repos, klass, { title: 'Bookmarked' })
  await relaunched.start(klass, lecF)
  feed(relaunched, 3)
  await waitFor(() => relaunched.getState().elapsedSec >= 0.29)
  const mark = await relaunched.addBookmark('on the exam')
  const marksInState = relaunched.getState().bookmarks.length
  await relaunched.stop()
  await relaunched.queue.idle()
  const saved = await readBookmarks(lecF.dirPath)
  check('a bookmark lands at the current moment of the lecture', Math.abs(mark.atSec - 0.3) < 0.15, String(mark.atSec))
  check(
    'bookmarks are saved in the lecture folder',
    saved.length === 1 && saved[0]?.note === 'on the exam',
    JSON.stringify(saved)
  )
  check('the recording screen sees its bookmarks', marksInState === 1, String(marksInState))
  let refusedWhenIdle = false
  try {
    await relaunched.addBookmark('too late')
  } catch {
    refusedWhenIdle = true
  }
  check('bookmarking is refused when nothing is recording', refusedWhenIdle)

  // --- a lecture with no audio stays flagged, not "safe to retry" ----------
  const lecG = await createLecture(repos, klass, { title: 'Never recorded' })
  repos.lectures.setStatus(lecG.id, 'needs_transcription', null)
  relaunched.requestTranscription(lecG.id, 'retry')
  await relaunched.queue.idle()
  check(
    'a lecture with no audio stays flagged for attention',
    statusOf(lecG.id) === 'needs_attention',
    `${statusOf(lecG.id)}: ${repos.lectures.get(lecG.id)?.statusDetail}`
  )

  // --- cancelling ----------------------------------------------------------
  const gate3 = gatedTranscriber(stubTranscriber)
  const canceller = makeController(gate3.transcriber)
  const lecH1 = await createLecture(repos, klass, { title: 'Cancel running' })
  const lecH2 = await createLecture(repos, klass, { title: 'Cancel waiting' })
  for (const lecture of [lecH1, lecH2]) {
    await canceller.start(klass, lecture)
    feed(canceller, 12)
    await canceller.stop()
  }
  await waitFor(() => gate3.pending() === 1)

  await canceller.cancelTranscription(lecH2.id)
  check(
    'cancelling a waiting lecture takes it out of the queue',
    !canceller.queue.has(lecH2.id) && statusOf(lecH2.id) === 'needs_transcription',
    statusOf(lecH2.id)
  )

  let refusal = ''
  try {
    await canceller.start(klass, repos.lectures.get(lecH1.id)!)
  } catch (err) {
    refusal = (err as Error).message
  }
  check('recording into a lecture being transcribed is refused', refusal.includes('transcribed'), refusal)

  await canceller.cancelTranscription(lecH1.id)
  check(
    'cancelling the running lecture stops it',
    gate3.aborted() === 1 && statusOf(lecH1.id) === 'needs_transcription',
    `${gate3.aborted()} aborted, ${statusOf(lecH1.id)}`
  )

  await recorder.shutdown()
  await relaunched.shutdown()
  await canceller.shutdown()
}
