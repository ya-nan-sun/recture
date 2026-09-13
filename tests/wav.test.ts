import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  WavSegmentWriter,
  buildWavHeader,
  concatWavFiles,
  parseWavHeader,
  readWavInfo,
  repairTruncatedWav,
  sha256File,
  verifySegmentFile,
  WAV_HEADER_BYTES
} from '@main/audio/wav'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-wav-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

/** `seconds` of a recognizable ramp, so concatenation order is verifiable. */
function pcm(seconds: number, seed = 1): Buffer {
  const samples = Math.round(16000 * seconds)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(((i * seed) % 1000) - 500, i * 2)
  return buf
}

describe('wav header', () => {
  it('round-trips through build and parse', () => {
    const header = buildWavHeader(32000)
    const parsed = parseWavHeader(Buffer.concat([header, Buffer.alloc(32000)]))
    expect(parsed.format).toEqual({ sampleRate: 16000, channels: 1, bitsPerSample: 16 })
    expect(parsed.dataByteLength).toBe(32000)
    expect(parsed.durationSec).toBeCloseTo(1, 6)
    expect(parsed.dataOffset).toBe(WAV_HEADER_BYTES)
  })

  it('trusts the real file length over a header that overstates it', () => {
    // This is the shape a crash mid-write leaves behind.
    const header = buildWavHeader(999_999)
    const parsed = parseWavHeader(Buffer.concat([header, Buffer.alloc(1000)]))
    expect(parsed.dataByteLength).toBe(1000)
  })

  it('skips non-audio chunks to find the data chunk', () => {
    const fmtAndData = buildWavHeader(400)
    const list = Buffer.alloc(8 + 10)
    list.write('LIST', 0, 'ascii')
    list.writeUInt32LE(10, 4)
    // RIFF / size / WAVE, then LIST, then the fmt+data from a canonical header.
    const file = Buffer.concat([fmtAndData.subarray(0, 12), list, fmtAndData.subarray(12), Buffer.alloc(400)])
    const parsed = parseWavHeader(file)
    expect(parsed.dataByteLength).toBe(400)
    expect(parsed.format.sampleRate).toBe(16000)
  })

  it('rejects a non-PCM encoding rather than mis-decoding it', () => {
    const header = buildWavHeader(16)
    header.writeUInt16LE(3, 20) // IEEE float
    expect(() => parseWavHeader(Buffer.concat([header, Buffer.alloc(16)]))).toThrow(/Unsupported WAV encoding/)
  })
})

describe('WavSegmentWriter', () => {
  it('writes a valid segment and a checksum of the bytes actually on disk', async () => {
    const file = path.join(dir, 'segment-0001.wav')
    const writer = await WavSegmentWriter.open(file)
    await writer.append(pcm(0.5))
    await writer.append(pcm(0.5))
    const result = await writer.finalize()

    expect(result.byteLength).toBe(16000 * 2) // 1s of 16-bit 16kHz mono
    expect(result.durationSec).toBeCloseTo(1, 6)
    // The checksum must describe the file, not the in-memory buffer.
    expect(result.sha256).toBe(await sha256File(file))

    const info = await readWavInfo(file)
    expect(info.dataByteLength).toBe(result.byteLength)
    expect(info.durationSec).toBeCloseTo(1, 6)
  })

  it('refuses to overwrite an existing segment', async () => {
    const file = path.join(dir, 'segment-0001.wav')
    await (await WavSegmentWriter.open(file)).finalize()
    await expect(WavSegmentWriter.open(file)).rejects.toThrow()
  })

  it('refuses to append after finalize', async () => {
    const writer = await WavSegmentWriter.open(path.join(dir, 'a.wav'))
    await writer.finalize()
    await expect(writer.append(pcm(0.1))).rejects.toThrow(/finalized/)
  })

  it('leaves an aborted segment recoverable, and does not claim its audio', async () => {
    const file = path.join(dir, 'aborted.wav')
    const writer = await WavSegmentWriter.open(file)
    await writer.append(pcm(0.25))
    await writer.abort() // header still claims 0 bytes of data

    const info = await readWavInfo(file)
    // Unclaimed audio must not be reported as valid data...
    expect(info.dataByteLength).toBe(0)
    // ...but it is still on disk, and visible as recoverable.
    expect(info.trailingBytes).toBe(8000)
    expect((await fs.stat(file)).size).toBe(WAV_HEADER_BYTES + 8000)
  })

  it('repairs a crashed segment by claiming the audio actually present', async () => {
    const file = path.join(dir, 'crashed.wav')
    const writer = await WavSegmentWriter.open(file)
    await writer.append(pcm(0.25))
    await writer.abort()

    const result = await repairTruncatedWav(file)
    expect(result.repaired).toBe(true)
    expect(result.byteLength).toBe(8000)
    expect(result.durationSec).toBeCloseTo(0.25, 6)
    expect(result.sha256).toBe(await sha256File(file))

    const info = await readWavInfo(file)
    expect(info.dataByteLength).toBe(8000)
    expect(info.trailingBytes).toBe(0)
  })

  it('leaves an intact segment alone when asked to repair it', async () => {
    const file = path.join(dir, 'intact.wav')
    const writer = await WavSegmentWriter.open(file)
    await writer.append(pcm(0.25))
    const { sha256 } = await writer.finalize()

    const result = await repairTruncatedWav(file)
    expect(result.repaired).toBe(false)
    expect(result.sha256).toBe(sha256)
  })

  it('discards a torn final sample frame rather than emitting noise', async () => {
    const file = path.join(dir, 'torn.wav')
    const writer = await WavSegmentWriter.open(file)
    await writer.append(pcm(0.25))
    await writer.abort()
    // Simulate the process dying mid-sample: one stray byte.
    await fs.appendFile(file, Buffer.from([0x7f]))

    const result = await repairTruncatedWav(file)
    expect(result.byteLength).toBe(8000) // odd byte dropped, frame-aligned
  })
})

describe('verifySegmentFile', () => {
  it('accepts an untouched segment', async () => {
    const file = path.join(dir, 'ok.wav')
    const writer = await WavSegmentWriter.open(file)
    await writer.append(pcm(1))
    const { sha256 } = await writer.finalize()
    expect(await verifySegmentFile(file, sha256)).toMatchObject({ ok: true })
  })

  it('detects a single flipped byte', async () => {
    const file = path.join(dir, 'bitrot.wav')
    const writer = await WavSegmentWriter.open(file)
    await writer.append(pcm(1))
    const { sha256 } = await writer.finalize()

    const handle = await fs.open(file, 'r+')
    await handle.write(Buffer.from([0xff]), 0, 1, WAV_HEADER_BYTES + 500)
    await handle.close()

    const result = await verifySegmentFile(file, sha256)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('checksum_mismatch')
  })

  it('reports a missing file rather than throwing', async () => {
    const result = await verifySegmentFile(path.join(dir, 'nope.wav'), 'deadbeef')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('missing')
  })
})

describe('concatWavFiles', () => {
  it('splices segments in order, byte-exactly', async () => {
    const parts: Buffer[] = []
    const files: string[] = []
    for (let i = 1; i <= 3; i++) {
      const file = path.join(dir, `segment-000${i}.wav`)
      const data = pcm(0.5, i)
      parts.push(data)
      const writer = await WavSegmentWriter.open(file)
      await writer.append(data)
      await writer.finalize()
      files.push(file)
    }

    const out = path.join(dir, 'final.wav')
    const result = await concatWavFiles(files, out)

    const expected = Buffer.concat(parts)
    expect(result.byteLength).toBe(expected.length)
    expect(result.durationSec).toBeCloseTo(1.5, 6)

    const written = await fs.readFile(out)
    expect(written.subarray(WAV_HEADER_BYTES).equals(expected)).toBe(true)
    expect(result.sha256).toBe(await sha256File(out))
  })

  it('refuses to assemble an empty lecture', async () => {
    await expect(concatWavFiles([], path.join(dir, 'x.wav'))).rejects.toThrow(/no verified segments/)
  })

  it('refuses to splice a segment recorded at a different sample rate', async () => {
    const good = path.join(dir, 'good.wav')
    const w1 = await WavSegmentWriter.open(good)
    await w1.append(pcm(0.2))
    await w1.finalize()

    const odd = path.join(dir, 'odd.wav')
    const w2 = await WavSegmentWriter.open(odd, { sampleRate: 44100, channels: 1, bitsPerSample: 16 })
    await w2.append(pcm(0.2))
    await w2.finalize()

    await expect(concatWavFiles([good, odd], path.join(dir, 'out.wav'))).rejects.toThrow(/44100Hz/)
  })
})
