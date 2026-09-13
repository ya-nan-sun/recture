import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { RecordingSession, type SegmentManifest } from '@main/audio/recordingSession'
import { verifySegmentFile, readWavInfo } from '@main/audio/wav'
import { lecturePaths } from '@main/storage/paths'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lecturerec-session-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const BYTES_PER_SEC = 16000 * 2

/** One frame of `ms` milliseconds of PCM. */
function frame(ms: number, value = 1000): Buffer {
  const samples = Math.round((16000 * ms) / 1000)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(value, i * 2)
  return buf
}

async function readManifest(): Promise<SegmentManifest> {
  return JSON.parse(await fs.readFile(lecturePaths(dir).manifest, 'utf8')) as SegmentManifest
}

describe('RecordingSession', () => {
  it('rolls over on captured audio and checksums every completed segment', async () => {
    const completed: string[] = []
    const session = new RecordingSession({
      lectureId: 'lec-1',
      lectureDir: dir,
      segmentSeconds: 1,
      onSegmentComplete: (e) => completed.push(e.relPath)
    })
    await session.start()

    // 2.5 seconds in 100 ms frames -> two full segments plus a partial.
    for (let i = 0; i < 25; i++) session.write(frame(100))
    await session.stop()

    const manifest = await readManifest()
    expect(manifest.segments).toHaveLength(3)
    expect(completed).toEqual(['audio/segment-0001.wav', 'audio/segment-0002.wav', 'audio/segment-0003.wav'])

    // Each recorded checksum must match the file as it sits on disk.
    for (const seg of manifest.segments) {
      const abs = path.join(dir, ...seg.relPath.split('/'))
      expect(await verifySegmentFile(abs, seg.sha256)).toMatchObject({ ok: true })
    }

    expect(manifest.segments[0]!.byteLength).toBe(BYTES_PER_SEC)
    expect(manifest.segments[1]!.byteLength).toBe(BYTES_PER_SEC)
    expect(manifest.segments[2]!.byteLength).toBe(BYTES_PER_SEC / 2)
    expect(manifest.closedAt).toBeTruthy()
    expect(manifest.totalDurationSec).toBeCloseTo(2.5, 5)
  })

  it('writes segments contiguously with no gap or overlap in start times', async () => {
    const session = new RecordingSession({ lectureId: 'lec-2', lectureDir: dir, segmentSeconds: 1 })
    await session.start()
    for (let i = 0; i < 30; i++) session.write(frame(100))
    await session.stop()

    const { segments } = await readManifest()
    let expectedStart = 0
    for (const seg of segments) {
      expect(seg.startSec).toBeCloseTo(expectedStart, 6)
      expectedStart += seg.durationSec
    }
    expect(expectedStart).toBeCloseTo(3, 5)
  })

  it('preserves frame order under rapid unawaited writes', async () => {
    const session = new RecordingSession({ lectureId: 'lec-3', lectureDir: dir, segmentSeconds: 60 })
    await session.start()
    // Distinct value per frame so any reordering is detectable.
    for (let i = 0; i < 50; i++) session.write(frame(20, i + 1))
    await session.stop()

    const { segments } = await readManifest()
    expect(segments).toHaveLength(1)

    const abs = path.join(dir, ...segments[0]!.relPath.split('/'))
    const info = await readWavInfo(abs)
    const buf = await fs.readFile(abs)
    const samplesPerFrame = 320 // 20 ms @ 16 kHz
    for (let i = 0; i < 50; i++) {
      const at = info.dataOffset + i * samplesPerFrame * 2
      expect(buf.readInt16LE(at)).toBe(i + 1)
    }
  })

  it('keeps audio already on disk when a write fails mid-lecture', async () => {
    const errors: Error[] = []
    const session = new RecordingSession({
      lectureId: 'lec-4',
      lectureDir: dir,
      segmentSeconds: 1,
      onError: (e) => errors.push(e)
    })
    await session.start()
    for (let i = 0; i < 15; i++) session.write(frame(100))
    await session.flush()

    const manifestBefore = await readManifest()
    expect(manifestBefore.segments.length).toBeGreaterThanOrEqual(1)

    // Simulate the disk going away underneath the writer. Close the real
    // writer's handle first so the stub doesn't orphan an open descriptor.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realWriter = (session as any).writer as { abort: () => Promise<void> }
    await realWriter.abort()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any).writer = {
      append: () => Promise.reject(new Error('ENOSPC: no space left on device')),
      byteLength: 0,
      durationSec: 0
    }
    session.write(frame(100))
    await session.flush()

    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toMatch(/ENOSPC/)
    expect(session.isStopped).toBe(true)

    // The segments written before the failure are untouched and still verify.
    const manifestAfter = await readManifest()
    expect(manifestAfter.segments).toEqual(manifestBefore.segments)
    for (const seg of manifestAfter.segments) {
      const abs = path.join(dir, ...seg.relPath.split('/'))
      expect(await verifySegmentFile(abs, seg.sha256)).toMatchObject({ ok: true })
    }
  })

  it('keeps every queued frame when stop() lands before the writes drain', async () => {
    // Regression: stop() marks the session closed synchronously while frames
    // are still queued. If that flag also suppressed opening the next segment,
    // the first rollover would silently drop the rest of the lecture.
    const session = new RecordingSession({ lectureId: 'lec-7', lectureDir: dir, segmentSeconds: 1 })
    await session.start()
    for (let i = 0; i < 40; i++) session.write(frame(100)) // 4 s, no await
    await session.stop()

    const { segments } = await readManifest()
    const total = segments.reduce((n, s) => n + s.byteLength, 0)
    expect(total).toBe(4 * BYTES_PER_SEC) // nothing lost
    expect(segments).toHaveLength(4)
    expect(session.error).toBeNull()
  })

  it('ignores frames after stop', async () => {
    const session = new RecordingSession({ lectureId: 'lec-5', lectureDir: dir, segmentSeconds: 60 })
    await session.start()
    session.write(frame(100))
    await session.stop()
    session.write(frame(100))
    await session.flush()

    const { segments } = await readManifest()
    expect(segments).toHaveLength(1)
    expect(segments[0]!.byteLength).toBe(BYTES_PER_SEC / 10)
  })

  it('writes a manifest at start so a crashed lecture is still discoverable', async () => {
    const session = new RecordingSession({ lectureId: 'lec-6', lectureDir: dir, segmentSeconds: 60 })
    await session.start()

    const manifest = await readManifest()
    expect(manifest.lectureId).toBe('lec-6')
    expect(manifest.segments).toEqual([])
    expect(manifest.closedAt).toBeUndefined() // not closed == crashed, if we stop here
    await session.abort()
  })
})
