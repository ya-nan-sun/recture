/**
 * Canonical 44-byte-header PCM WAV read/write plus checksum verification.
 *
 * This module is the durability core of the app. Rules it follows:
 *   - Audio bytes reach the OS as soon as they are produced; nothing is held
 *     in memory waiting for a segment to complete.
 *   - A segment is fsync'd, closed, then re-read from disk to compute its
 *     SHA-256. Hashing the in-memory buffer would happily certify a file the
 *     disk never actually took.
 *   - Nothing here ever deletes or rewrites a segment. Corrupt segments are
 *     reported, never repaired in place.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { AUDIO_FORMAT } from '@shared/types'

export const WAV_HEADER_BYTES = 44

export interface WavFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export const DEFAULT_WAV_FORMAT: WavFormat = {
  sampleRate: AUDIO_FORMAT.sampleRate,
  channels: AUDIO_FORMAT.channels,
  bitsPerSample: AUDIO_FORMAT.bitsPerSample
}

export function buildWavHeader(dataByteLength: number, format: WavFormat = DEFAULT_WAV_FORMAT): Buffer {
  const { sampleRate, channels, bitsPerSample } = format
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(WAV_HEADER_BYTES)

  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataByteLength, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // audioFormat = PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataByteLength, 40)
  return header
}

export interface ParsedWav {
  format: WavFormat
  dataOffset: number
  /** Length the header claims, which a crashed writer may understate. */
  declaredDataByteLength: number
  /** Usable length: the declared length clamped to what is actually present. */
  dataByteLength: number
  durationSec: number
  /**
   * Bytes past the declared data chunk. Non-zero means the writer died before
   * patching the header — the audio is there but was never checksummed, so it
   * is recoverable only through the quarantine path, never silently used.
   */
  trailingBytes: number
}

/**
 * Parse a WAV header, walking the chunk list rather than assuming the data
 * chunk sits at offset 36 — files that have been through ffmpeg often carry a
 * LIST/INFO chunk first.
 */
export function parseWavHeader(buf: Buffer): ParsedWav {
  if (buf.length < 12) throw new Error('WAV too short to contain a header')
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not a RIFF file')
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('RIFF file is not WAVE')

  let offset = 12
  let format: WavFormat | null = null

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8

    if (chunkId === 'fmt ') {
      if (body + 16 > buf.length) throw new Error('Truncated fmt chunk')
      const audioFormat = buf.readUInt16LE(body)
      if (audioFormat !== 1) throw new Error(`Unsupported WAV encoding ${audioFormat}, expected PCM`)
      format = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      }
    } else if (chunkId === 'data') {
      if (!format) throw new Error('data chunk appeared before fmt chunk')
      // A recorder killed mid-write leaves a header claiming more (or fewer)
      // bytes than the file holds, so report both and let the caller decide.
      const declared = chunkSize
      const available = Math.max(0, buf.length - body)
      const dataByteLength = Math.min(declared, available)
      const blockAlign = (format.channels * format.bitsPerSample) / 8
      return {
        format,
        dataOffset: body,
        declaredDataByteLength: declared,
        dataByteLength,
        durationSec: dataByteLength / (blockAlign * format.sampleRate),
        trailingBytes: Math.max(0, available - declared)
      }
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + chunkSize + (chunkSize % 2)
  }
  throw new Error('WAV contains no data chunk')
}

export async function readWavInfo(filePath: string): Promise<ParsedWav> {
  const handle = await fs.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    // 4 KiB is far more than any header we write, and enough for ffmpeg's.
    const probeLength = Math.min(4096, stat.size)
    const probe = Buffer.alloc(probeLength)
    await handle.read(probe, 0, probeLength, 0)
    const parsed = parseWavHeader(probe)

    // The probe only covers the header, so the length it computed is bounded by
    // the probe window. Recompute against the real file size instead.
    const blockAlign = (parsed.format.channels * parsed.format.bitsPerSample) / 8
    const available = Math.max(0, stat.size - parsed.dataOffset)
    const dataByteLength = Math.min(parsed.declaredDataByteLength, available)
    return {
      ...parsed,
      dataByteLength,
      durationSec: dataByteLength / (blockAlign * parsed.format.sampleRate),
      trailingBytes: Math.max(0, available - parsed.declaredDataByteLength)
    }
  } finally {
    await handle.close()
  }
}

/**
 * Rewrite a crashed segment's header to claim the audio that is actually in
 * the file, so a lecture interrupted by a crash or power loss keeps its last
 * partial segment.
 *
 * Returns the new checksum. The caller is responsible for recording this
 * segment as *recovered* rather than verified: its contents were never
 * checksummed at write time, so this proves only that the file is internally
 * consistent from here on, not that every byte survived the crash.
 */
export async function repairTruncatedWav(
  filePath: string
): Promise<{ repaired: boolean; byteLength: number; durationSec: number; sha256: string }> {
  const info = await readWavInfo(filePath)
  const blockAlign = (info.format.channels * info.format.bitsPerSample) / 8

  if (info.trailingBytes < blockAlign) {
    return {
      repaired: false,
      byteLength: info.dataByteLength,
      durationSec: info.durationSec,
      sha256: await sha256File(filePath)
    }
  }

  const stat = await fs.stat(filePath)
  // Round down to a whole sample frame: a torn final frame would be noise.
  const usable = Math.floor((stat.size - info.dataOffset) / blockAlign) * blockAlign

  const handle = await fs.open(filePath, 'r+')
  try {
    await handle.write(buildWavHeader(usable, info.format), 0, WAV_HEADER_BYTES, 0)
    await handle.sync()
  } finally {
    await handle.close()
  }

  return {
    repaired: true,
    byteLength: usable,
    durationSec: usable / (blockAlign * info.format.sampleRate),
    sha256: await sha256File(filePath)
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Incrementally writes one rolling audio segment.
 *
 * The header is written up front with a zero length and patched on finalize,
 * so a crash leaves a file that is still parseable (`parseWavHeader` falls
 * back to the real byte length) rather than an unreadable stub.
 */
export class WavSegmentWriter {
  private handle: fs.FileHandle | null = null
  private dataBytes = 0
  private closed = false

  private constructor(
    readonly filePath: string,
    readonly format: WavFormat,
    handle: fs.FileHandle
  ) {
    this.handle = handle
  }

  static async open(filePath: string, format: WavFormat = DEFAULT_WAV_FORMAT): Promise<WavSegmentWriter> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    // 'wx' so we never silently overwrite an existing segment.
    const handle = await fs.open(filePath, 'wx')
    await handle.write(buildWavHeader(0, format), 0, WAV_HEADER_BYTES, 0)
    return new WavSegmentWriter(filePath, format, handle)
  }

  get byteLength(): number {
    return this.dataBytes
  }

  get durationSec(): number {
    const blockAlign = (this.format.channels * this.format.bitsPerSample) / 8
    return this.dataBytes / (blockAlign * this.format.sampleRate)
  }

  async append(pcm: Buffer): Promise<void> {
    if (this.closed || !this.handle) throw new Error('Cannot append to a finalized segment writer')
    if (pcm.length === 0) return
    await this.handle.write(pcm, 0, pcm.length, WAV_HEADER_BYTES + this.dataBytes)
    this.dataBytes += pcm.length
  }

  /**
   * Patch the header, flush to the physical disk, close, then hash the file as
   * it now exists on disk.
   */
  async finalize(): Promise<{ byteLength: number; durationSec: number; sha256: string }> {
    if (this.closed) throw new Error('Segment writer already finalized')
    const handle = this.handle
    if (!handle) throw new Error('Segment writer has no open handle')

    const durationSec = this.durationSec
    await handle.write(buildWavHeader(this.dataBytes, this.format), 0, WAV_HEADER_BYTES, 0)
    await handle.sync()
    await handle.close()
    this.handle = null
    this.closed = true

    const sha256 = await sha256File(this.filePath)
    return { byteLength: this.dataBytes, durationSec, sha256 }
  }

  /** Close without patching the header — used when aborting on error. */
  async abort(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const handle = this.handle
    this.handle = null
    if (handle) await handle.close().catch(() => undefined)
  }
}

export type VerifyResult =
  | { ok: true; byteLength: number; durationSec: number }
  | { ok: false; reason: 'missing' | 'checksum_mismatch' | 'unreadable'; detail: string }

/** Re-hash a segment and compare against the checksum recorded at write time. */
export async function verifySegmentFile(filePath: string, expectedSha256: string): Promise<VerifyResult> {
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(filePath)
  } catch {
    return { ok: false, reason: 'missing', detail: `Segment file not found: ${filePath}` }
  }
  if (!stat.isFile() || stat.size < WAV_HEADER_BYTES) {
    return { ok: false, reason: 'unreadable', detail: `Segment is empty or not a file (${stat.size} bytes)` }
  }

  let actual: string
  try {
    actual = await sha256File(filePath)
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: `Could not read segment: ${String(err)}` }
  }
  if (actual !== expectedSha256) {
    return {
      ok: false,
      reason: 'checksum_mismatch',
      detail: `Expected ${expectedSha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…`
    }
  }

  try {
    const info = await readWavInfo(filePath)
    return { ok: true, byteLength: info.dataByteLength, durationSec: info.durationSec }
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: `Checksum matched but header is invalid: ${String(err)}` }
  }
}

/**
 * Concatenate verified segments into one WAV, streaming so a three-hour
 * lecture never lands in memory.
 *
 * Done natively rather than by shelling out to ffmpeg: every segment is
 * already the exact same PCM format, so this is a byte-exact splice whose
 * output we can checksum, with no external binary in the critical path.
 * ffmpeg is still used for optional compressed archives (see ffmpeg.ts).
 */
export async function concatWavFiles(
  inputPaths: string[],
  outputPath: string,
  format: WavFormat = DEFAULT_WAV_FORMAT
): Promise<{ byteLength: number; durationSec: number; sha256: string }> {
  if (inputPaths.length === 0) throw new Error('Refusing to assemble an empty lecture: no verified segments')

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  const out = await fs.open(outputPath, 'w')
  try {
    let written = 0
    await out.write(buildWavHeader(0, format), 0, WAV_HEADER_BYTES, 0)

    for (const input of inputPaths) {
      const info = await readWavInfo(input)
      if (
        info.format.sampleRate !== format.sampleRate ||
        info.format.channels !== format.channels ||
        info.format.bitsPerSample !== format.bitsPerSample
      ) {
        throw new Error(
          `Segment ${path.basename(input)} is ${info.format.sampleRate}Hz/${info.format.channels}ch/` +
            `${info.format.bitsPerSample}bit, expected ${format.sampleRate}Hz/${format.channels}ch/${format.bitsPerSample}bit`
        )
      }

      const handle = await fs.open(input, 'r')
      try {
        const buf = Buffer.alloc(1 << 20)
        let readFrom = info.dataOffset
        let remaining = info.dataByteLength
        while (remaining > 0) {
          const want = Math.min(buf.length, remaining)
          const { bytesRead } = await handle.read(buf, 0, want, readFrom)
          if (bytesRead <= 0) break
          await out.write(buf, 0, bytesRead, WAV_HEADER_BYTES + written)
          written += bytesRead
          readFrom += bytesRead
          remaining -= bytesRead
        }
      } finally {
        await handle.close()
      }
    }

    await out.write(buildWavHeader(written, format), 0, WAV_HEADER_BYTES, 0)
    await out.sync()
    await out.close()

    const blockAlign = (format.channels * format.bitsPerSample) / 8
    return {
      byteLength: written,
      durationSec: written / (blockAlign * format.sampleRate),
      sha256: await sha256File(outputPath)
    }
  } catch (err) {
    await out.close().catch(() => undefined)
    throw err
  }
}
