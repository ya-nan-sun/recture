import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { RecordingSession, isAudioArchive, type SegmentManifest } from '@main/audio/recordingSession'
import {
  assembleLectureAudio,
  compactLectureAudio,
  verifyArchiveFile,
  type LectureAudioSource
} from '@main/audio/archive'
import { concatWavFiles, readWavInfo, sha256File } from '@main/audio/wav'
import { lecturePaths } from '@main/storage/paths'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-archive-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function frame(ms: number, value: number): Buffer {
  const samples = Math.round((16000 * ms) / 1000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2)
  return buf
}

/** Record `frames` × 100 ms of a constant sample value, in 1 s segments. */
async function record(frames: number, value = 1000): Promise<RecordingSession> {
  const errors: Error[] = []
  const session = new RecordingSession({ lectureId: 'L', lectureDir: dir, segmentSeconds: 1, onError: (e) => errors.push(e) })
  await session.start()
  for (let i = 0; i < frames; i++) session.write(frame(100, value))
  await session.stop()
  expect(errors).toEqual([])
  return session
}

async function manifest(): Promise<SegmentManifest> {
  return JSON.parse(await fs.readFile(lecturePaths(dir).manifest, 'utf8')) as SegmentManifest
}

async function audioFiles(): Promise<string[]> {
  return (await fs.readdir(path.join(dir, 'audio'))).sort()
}

const abs = (relPath: string): string => path.join(dir, ...relPath.split('/'))

/** What the pipeline hands over: the archive first, then segments recorded since. */
async function sources(): Promise<LectureAudioSource[]> {
  const m = await manifest()
  const list: LectureAudioSource[] = []
  if (m.archive) list.push({ relPath: m.archive.relPath, absPath: abs(m.archive.relPath), kind: 'archive', format: m.archive.format })
  for (const s of m.segments) list.push({ relPath: s.relPath, absPath: abs(s.relPath), kind: 'segment', format: 'wav' })
  return list
}

/** Assemble and compact, as a successful transcription pass does. */
async function transcribeAndCompact(format: 'wav' | 'opus' = 'wav') {
  const assembled = await assembleLectureAudio(dir, await sources())
  const result = await compactLectureAudio({ lectureDir: dir, audioPath: assembled.audioPath, format })
  return { assembled, result }
}

describe('keeping a transcribed lecture as one file', { timeout: 60_000 }, () => {
  it('folds its segments into one checksummed WAV, then removes them', async () => {
    await record(25)
    const assembled = await assembleLectureAudio(dir, await sources())
    const assembledSha = await sha256File(assembled.audioPath)
    const { archive } = await compactLectureAudio({ lectureDir: dir, audioPath: assembled.audioPath, format: 'wav' })

    expect(archive.sha256).toBe(assembledSha)
    expect(archive.durationSec).toBeCloseTo(2.5, 5)
    expect(archive.throughIndex).toBe(3)
    expect(isAudioArchive(archive)).toBe(true)

    const m = await manifest()
    expect(m.segments).toEqual([])
    expect(m.archive).toEqual(archive)
    expect(m.totalDurationSec).toBeCloseTo(2.5, 5)
    expect(await audioFiles()).toEqual([path.basename(archive.relPath), 'segments.json'])
    expect(await verifyArchiveFile(abs(archive.relPath), archive)).toMatchObject({ ok: true })
  })

  it('transcribes a lecture that is already one WAV where it is, without a copy', async () => {
    await record(25)
    const { result } = await transcribeAndCompact()

    const again = await assembleLectureAudio(dir, await sources())
    expect(again.audioPath).toBe(abs(result.archive.relPath))
    expect(await audioFiles()).not.toContain('final.wav')

    const second = await compactLectureAudio({ lectureDir: dir, audioPath: again.audioPath, format: 'wav' })
    expect(second.archive).toEqual(result.archive)
    expect(await audioFiles()).toEqual([path.basename(result.archive.relPath), 'segments.json'])
  })

  it('records into a compacted lecture after its audio, then folds the new audio in', async () => {
    await record(25, 1)
    const { result: first } = await transcribeAndCompact()

    const session = await record(12, 2)
    expect(session.offsetSec).toBeCloseTo(2.5, 5)

    const m = await manifest()
    expect(m.archive).toEqual(first.archive)
    expect(m.segments.map((s) => s.index)).toEqual([4, 5])
    expect(m.segments[0]!.startSec).toBeCloseTo(2.5, 5)
    expect(m.totalDurationSec).toBeCloseTo(3.7, 5)

    const { assembled, result } = await transcribeAndCompact()
    expect(assembled.durationSec).toBeCloseTo(3.7, 5)
    expect(result.archive.throughIndex).toBe(5)
    expect(await audioFiles()).toEqual([path.basename(result.archive.relPath), 'segments.json'])

    // Every sample, old then new, in order.
    const file = abs(result.archive.relPath)
    const info = await readWavInfo(file)
    const buf = await fs.readFile(file)
    const at = (sec: number): number => buf.readInt16LE(info.dataOffset + Math.round(sec * 16000) * 2)
    expect([at(0.1), at(2.4), at(2.6), at(3.6)]).toEqual([1, 1, 2, 2])
  })

  it('compresses to Opus when asked, and decodes back to the same length', async () => {
    await record(25)
    const { result } = await transcribeAndCompact('opus')

    expect(result.archive.format).toBe('opus')
    expect(result.archive.relPath).toMatch(/^audio\/lecture-[0-9a-f]+\.opus$/)
    expect(result.archive.byteLength).toBeLessThan((2.5 * 32_000 + 44) / 4)
    expect(await audioFiles()).toEqual([path.basename(result.archive.relPath), 'segments.json'])
    expect(await verifyArchiveFile(abs(result.archive.relPath), result.archive)).toMatchObject({ ok: true })

    const decoded = await assembleLectureAudio(dir, await sources())
    expect(decoded.audioPath).toBe(lecturePaths(dir).finalAudio)
    expect(Math.abs(decoded.durationSec - 2.5)).toBeLessThan(0.1)

    // Switching storage back to WAV replaces the Opus file.
    const back = await compactLectureAudio({ lectureDir: dir, audioPath: decoded.audioPath, format: 'wav' })
    expect(back.archive.format).toBe('wav')
    expect(await audioFiles()).toEqual([path.basename(back.archive.relPath), 'segments.json'])
  })

  it('refuses to replace segments with audio that does not hold all of them', async () => {
    await record(25)
    const before = await manifest()
    const partial = lecturePaths(dir).finalAudio
    await concatWavFiles([abs('audio/segment-0001.wav')], partial)

    await expect(compactLectureAudio({ lectureDir: dir, audioPath: partial, format: 'wav' })).rejects.toThrow(
      /does not match/
    )
    expect(await manifest()).toEqual(before)
    expect(await audioFiles()).toEqual(['final.wav', 'segment-0001.wav', 'segment-0002.wav', 'segment-0003.wav', 'segments.json'])
  })

  it('leaves everything in place if compression is cancelled', async () => {
    await record(25)
    const before = await manifest()
    const assembled = await assembleLectureAudio(dir, await sources())
    const abort = new AbortController()
    abort.abort()

    await expect(
      compactLectureAudio({ lectureDir: dir, audioPath: assembled.audioPath, format: 'opus', signal: abort.signal })
    ).rejects.toThrow()
    expect(await manifest()).toEqual(before)
    expect(await audioFiles()).toEqual(['final.wav', 'segment-0001.wav', 'segment-0002.wav', 'segment-0003.wav', 'segments.json'])
  })

  it('tidies up after an interrupted clean-up, and removes nothing else', async () => {
    await record(25)
    const { result } = await transcribeAndCompact()
    const archivePath = abs(result.archive.relPath)

    // As if the app died after switching the manifest over, before deleting.
    await fs.copyFile(archivePath, abs('audio/segment-0002.wav'))
    await fs.copyFile(archivePath, abs('audio/lecture-0123456789abcdef.wav'))
    await fs.copyFile(archivePath, lecturePaths(dir).finalAudio)
    // Not the archive's to delete: a segment the manifest never listed, and the student's own file.
    await fs.copyFile(archivePath, abs('audio/segment-0009.wav'))
    await fs.writeFile(abs('audio/notes.txt'), 'mine')

    await compactLectureAudio({ lectureDir: dir, audioPath: archivePath, format: 'wav' })
    expect(await audioFiles()).toEqual(
      [path.basename(result.archive.relPath), 'notes.txt', 'segment-0009.wav', 'segments.json'].sort()
    )
  })

  it('detects a damaged or missing archive', async () => {
    await record(25)
    const { result } = await transcribeAndCompact()
    const file = abs(result.archive.relPath)

    const handle = await fs.open(file, 'r+')
    await handle.write(Buffer.from([0x7f]), 0, 1, 1000)
    await handle.close()
    expect(await verifyArchiveFile(file, result.archive)).toMatchObject({ ok: false, reason: 'checksum_mismatch' })

    await fs.rm(file)
    expect(await verifyArchiveFile(file, result.archive)).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('never trusts a manifest that points outside the lecture folder', () => {
    const base = { format: 'wav', sha256: 'a'.repeat(64), byteLength: 1, durationSec: 1, throughIndex: 1, createdAt: '' }
    expect(isAudioArchive({ ...base, relPath: 'audio/lecture-0123456789abcdef.wav' })).toBe(true)
    expect(isAudioArchive({ ...base, relPath: '../../Documents/thesis.wav' })).toBe(false)
    expect(isAudioArchive({ ...base, relPath: 'audio/lecture-0123456789abcdef.wav/../../x.wav' })).toBe(false)
    expect(isAudioArchive({ ...base, relPath: 'audio/lecture-0123456789abcdef.opus' })).toBe(false)
    expect(isAudioArchive({ ...base, relPath: 'audio/lecture-0123456789abcdef.exe' })).toBe(false)
    expect(isAudioArchive(null)).toBe(false)
  })
})
