import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { importAudioFile, type ImportAudioOptions, type ImportTick } from '@main/audio/importAudio'
import { runFfmpeg } from '@main/audio/ffmpeg'
import { readWavInfo, verifySegmentFile } from '@main/audio/wav'
import type { SegmentManifest } from '@main/audio/recordingSession'
import { lecturePaths } from '@main/storage/paths'
import { makeTone } from './helpers/audioFixtures'

let dir: string
let lectureDir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-import-'))
  lectureDir = path.join(dir, 'lecture')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const importInto = (sourcePath: string, extra: Partial<ImportAudioOptions> = {}) =>
  importAudioFile({ lectureId: 'L', lectureDir, segmentSeconds: 1, sourcePath, ...extra })

async function readManifest(): Promise<SegmentManifest> {
  return JSON.parse(await fs.readFile(lecturePaths(lectureDir).manifest, 'utf8')) as SegmentManifest
}

/** Every sample of the imported lecture, in order. */
async function allSamples(): Promise<Int16Array> {
  const chunks: Buffer[] = []
  for (const segment of (await readManifest()).segments) {
    const abs = path.join(lectureDir, ...segment.relPath.split('/'))
    const info = await readWavInfo(abs)
    const buf = await fs.readFile(abs)
    chunks.push(buf.subarray(info.dataOffset, info.dataOffset + info.dataByteLength))
  }
  const joined = Buffer.concat(chunks)
  return new Int16Array(joined.buffer, joined.byteOffset, joined.length / 2)
}

describe('importing an audio or video file', { timeout: 60_000 }, () => {
  it('turns a stereo 44.1 kHz MP3 into checksummed 16 kHz mono segments', async () => {
    const source = await makeTone(dir, 'Voice memo.mp3', 3.3, ['-ac', '2'])
    const result = await importInto(source)

    expect(result.durationSec).toBeGreaterThan(3.25)
    expect(result.durationSec).toBeLessThan(3.45)

    const manifest = await readManifest()
    expect(manifest.closedAt).toBeTruthy()
    expect(manifest.segments.length).toBeGreaterThanOrEqual(2)
    expect(manifest.segments.reduce((n, s) => n + s.durationSec, 0)).toBeCloseTo(result.durationSec, 5)
    for (const segment of manifest.segments) {
      const abs = path.join(lectureDir, ...segment.relPath.split('/'))
      expect(await verifySegmentFile(abs, segment.sha256)).toMatchObject({ ok: true })
      const info = await readWavInfo(abs)
      expect(info.format).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 })
    }
  })

  it('keeps the audio itself intact across segment boundaries', async () => {
    // A 440 Hz tone crosses zero 880 times a second. Samples shifted by a byte
    // anywhere along the way would turn it into noise and wreck that count.
    const source = await makeTone(dir, 'tone.m4a', 6, ['-c:a', 'aac'])
    await importInto(source)
    const samples = await allSamples()
    let crossings = 0
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings += 1
    }
    const perSecond = crossings / (samples.length / 16000)
    expect(perSecond).toBeGreaterThan(840)
    expect(perSecond).toBeLessThan(920)
  })

  it('takes the sound from a video file', async () => {
    const source = path.join(dir, 'zoom recording.mp4')
    await runFfmpeg([
      '-nostats', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest',
      source
    ])
    const result = await importInto(source)
    expect(result.durationSec).toBeGreaterThan(1.8)
    expect(result.durationSec).toBeLessThan(2.2)
  })

  it('reports progress against the length of the file', async () => {
    const source = await makeTone(dir, 'lecture.m4a', 12, ['-c:a', 'aac'])
    const ticks: ImportTick[] = []
    await importInto(source, { onProgress: (tick) => ticks.push(tick) })

    expect(ticks.length).toBeGreaterThan(1)
    const last = ticks[ticks.length - 1]!
    expect(last.totalSec).not.toBeNull()
    expect(last.totalSec!).toBeCloseTo(12, 0)
    expect(last.processedSec).toBeGreaterThan(11.5)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!.processedSec).toBeGreaterThanOrEqual(ticks[i - 1]!.processedSec)
  })

  it("explains a file that isn't audio", async () => {
    const source = path.join(dir, 'notes.mp3')
    await fs.writeFile(source, 'These are my notes, not a recording.\n'.repeat(200))
    await expect(importInto(source)).rejects.toThrow(/isn't audio or video|doesn't contain any audio/)
  })

  it('explains a video with no sound', async () => {
    const source = path.join(dir, 'silent.mp4')
    await runFfmpeg(['-nostats', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1', '-c:v', 'mpeg4', source])
    await expect(importInto(source)).rejects.toThrow(/doesn't have an audio track/)
  })

  it('explains a file that is not there, or is empty', async () => {
    await expect(importInto(path.join(dir, 'missing.mp3'))).rejects.toThrow(/could not be found/)
    const empty = path.join(dir, 'empty.m4a')
    await fs.writeFile(empty, '')
    await expect(importInto(empty)).rejects.toThrow(/empty/)
  })

  it('stops promptly when cancelled, and never touches the source file', async () => {
    const source = await makeTone(dir, 'long lecture.mp3', 120)
    const before = await fs.stat(source)
    const abort = new AbortController()
    const started = Date.now()

    await expect(importInto(source, { signal: abort.signal, onProgress: () => abort.abort() })).rejects.toMatchObject({
      name: 'FfmpegAbortedError'
    })
    expect(Date.now() - started).toBeLessThan(10_000)

    const after = await fs.stat(source)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })
})
