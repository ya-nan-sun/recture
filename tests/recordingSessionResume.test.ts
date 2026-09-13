import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { RecordingSession, type SegmentManifest } from '@main/audio/recordingSession'
import { WavSegmentWriter, readWavInfo, verifySegmentFile } from '@main/audio/wav'
import { lecturePaths } from '@main/storage/paths'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-resume-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const BYTES_PER_SEC = 16000 * 2

function frame(ms: number, value = 1000): Buffer {
  const samples = Math.round((16000 * ms) / 1000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2)
  return buf
}

async function readManifest(): Promise<SegmentManifest> {
  return JSON.parse(await fs.readFile(lecturePaths(dir).manifest, 'utf8')) as SegmentManifest
}

async function wavFiles(): Promise<string[]> {
  return (await fs.readdir(path.join(dir, 'audio'))).filter((f) => f.endsWith('.wav')).sort()
}

/** Record `frames` × 100 ms into the lecture, failing the test on any write error. */
async function record(frames: number, segmentSeconds = 1): Promise<RecordingSession> {
  const errors: Error[] = []
  const session = new RecordingSession({
    lectureId: 'L',
    lectureDir: dir,
    segmentSeconds,
    onError: (e) => errors.push(e)
  })
  await session.start()
  for (let i = 0; i < frames; i++) session.write(frame(100))
  await session.stop()
  expect(errors).toEqual([])
  return session
}

/** Every sample of the lecture's audio, in manifest order. */
async function allSamples(): Promise<number[]> {
  const { segments } = await readManifest()
  const values: number[] = []
  for (const seg of segments) {
    const abs = path.join(dir, ...seg.relPath.split('/'))
    const info = await readWavInfo(abs)
    const buf = await fs.readFile(abs)
    for (let at = info.dataOffset; at < info.dataOffset + info.dataByteLength; at += 2) {
      values.push(buf.readInt16LE(at))
    }
  }
  return values
}

describe('recording into a lecture that already has audio', () => {
  it('adds new segments instead of wiping the existing ones', async () => {
    // Regression: a second session rewrote segments.json with an empty list
    // (3 segments became 0), then failed with EEXIST on segment-0001.wav.
    await record(25) // 2.5 s -> 3 segments
    await record(12) // 1.2 s -> 2 more

    const { segments } = await readManifest()
    expect(segments.map((s) => s.index)).toEqual([1, 2, 3, 4, 5])
    expect(await wavFiles()).toHaveLength(5)
    for (const seg of segments) {
      const abs = path.join(dir, ...seg.relPath.split('/'))
      expect(await verifySegmentFile(abs, seg.sha256)).toMatchObject({ ok: true })
    }
  })

  it('continues the timeline where the existing audio ends', async () => {
    await record(25)
    const second = await record(12)

    expect(second.offsetSec).toBeCloseTo(2.5, 5)
    const { segments, totalDurationSec } = await readManifest()
    let expectedStart = 0
    for (const seg of segments) {
      expect(seg.startSec).toBeCloseTo(expectedStart, 5)
      expectedStart += seg.durationSec
    }
    expect(totalDurationSec).toBeCloseTo(3.7, 5)
  })

  it('numbers past segment files the manifest does not list', async () => {
    const stray = path.join(dir, 'audio', 'segment-0007.wav')
    const writer = await WavSegmentWriter.open(stray)
    await writer.append(frame(100))
    await writer.finalize()

    await record(12)

    const { segments } = await readManifest()
    expect(segments.map((s) => s.index)).toEqual([8, 9])
    // The stray file is left exactly where it was.
    expect((await fs.stat(stray)).size).toBeGreaterThan(44)
  })
})

describe('pausing a recording', () => {
  it('drops audio sent while paused and keeps what came before and after', async () => {
    const session = new RecordingSession({ lectureId: 'L', lectureDir: dir, segmentSeconds: 60 })
    await session.start()
    for (let i = 0; i < 5; i++) session.write(frame(100, 1))
    await session.pause()
    expect(session.isPaused).toBe(true)
    for (let i = 0; i < 5; i++) session.write(frame(100, 2))
    session.resume()
    for (let i = 0; i < 5; i++) session.write(frame(100, 3))
    await session.stop()

    const samples = await allSamples()
    expect(samples).toHaveLength(16000) // 0.5 s + 0.5 s; the paused 0.5 s is gone
    expect(samples.slice(0, 8000).every((v) => v === 1)).toBe(true)
    expect(samples.slice(8000).every((v) => v === 3)).toBe(true)
  })

  it('checksums the segment in progress as soon as it pauses', async () => {
    const session = new RecordingSession({ lectureId: 'L', lectureDir: dir, segmentSeconds: 60 })
    await session.start()
    for (let i = 0; i < 3; i++) session.write(frame(100))
    await session.pause()

    // A break can be long; nothing captured so far may sit unverified in an open file.
    const { segments } = await readManifest()
    expect(segments).toHaveLength(1)
    expect(segments[0]!.byteLength).toBe((BYTES_PER_SEC * 3) / 10)
    const abs = path.join(dir, ...segments[0]!.relPath.split('/'))
    expect(await verifySegmentFile(abs, segments[0]!.sha256)).toMatchObject({ ok: true })
    await session.stop()
  })

  it('leaves no empty segment files behind when stopped while paused', async () => {
    const session = new RecordingSession({ lectureId: 'L', lectureDir: dir, segmentSeconds: 60 })
    await session.start()
    for (let i = 0; i < 3; i++) session.write(frame(100))
    await session.pause()
    await session.stop()

    expect((await readManifest()).segments).toHaveLength(1)
    expect(await wavFiles()).toEqual(['segment-0001.wav'])
  })

  it('ignores pause and resume once stopped', async () => {
    const session = new RecordingSession({ lectureId: 'L', lectureDir: dir, segmentSeconds: 60 })
    await session.start()
    session.write(frame(100))
    await session.stop()
    await session.pause()
    session.resume()
    expect(session.isPaused).toBe(false)
    expect((await readManifest()).segments).toHaveLength(1)
  })
})
