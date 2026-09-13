/**
 * Owns one in-progress recording: takes PCM frames as they arrive from the
 * renderer and lands them on disk as rolling, checksummed WAV segments.
 *
 * Durability contract:
 *   - A frame is written to the OS as soon as it arrives. A lecture is never
 *     accumulated in memory; peak memory is one frame.
 *   - Writes are strictly serialized through a promise chain, so frames can
 *     never interleave or land out of order however fast IPC delivers them.
 *   - Rolling over a segment fsyncs it, re-reads it to compute SHA-256, and
 *     records that in `segments.json` before the next segment starts. A crash
 *     therefore costs at most the frames written since the last rollover, and
 *     every completed segment carries proof of its own integrity.
 *   - The manifest on disk is written before the DB row, because the files are
 *     the source of truth and the DB is a rebuildable index.
 */

import * as path from 'node:path'
import type { SegmentRecord } from '@shared/types'
import { AUDIO_FORMAT } from '@shared/types'
import { lecturePaths, segmentPath, segmentRelPath, writeJsonAtomic, ensureDir } from '../storage/paths'
import { DEFAULT_WAV_FORMAT, WavSegmentWriter, type WavFormat } from './wav'

export interface SegmentManifestEntry {
  index: number
  relPath: string
  startSec: number
  durationSec: number
  byteLength: number
  sha256: string
  createdAt: string
}

export interface SegmentManifest {
  version: 1
  lectureId: string
  format: WavFormat
  segmentSeconds: number
  segments: SegmentManifestEntry[]
  /** Set when the session ended cleanly; absent if the app died mid-lecture. */
  closedAt?: string
  totalDurationSec?: number
}

export interface RecordingSessionOptions {
  lectureId: string
  lectureDir: string
  segmentSeconds: number
  format?: WavFormat
  /** Called after each segment is finalized, verified and manifested. */
  onSegmentComplete?: (entry: SegmentManifestEntry) => void
  /** Called when a write fails; the session stops accepting frames. */
  onError?: (error: Error) => void
}

export class RecordingSession {
  private writer: WavSegmentWriter | null = null
  private readonly segments: SegmentManifestEntry[] = []
  private nextIndex = 1
  private elapsedBeforeCurrent = 0
  private bytesWritten = 0
  /** Serializes all filesystem work; every public method chains onto it. */
  private queue: Promise<void> = Promise.resolve()
  /**
   * Whether new frames are still accepted. Goes false the moment stop() is
   * called, while frames already queued are still written.
   */
  private accepting = true
  /**
   * Set only inside the final queued task — i.e. once every frame has landed.
   * Kept separate from `accepting` on purpose: frames are queued, not written,
   * when stop() returns, so a rollover triggered by one of those still-pending
   * frames must open the next segment. Conflating the two silently truncated
   * the lecture at its first rollover.
   */
  private finalizing = false
  private failed: Error | null = null
  private readonly format: WavFormat
  private readonly bytesPerSecond: number

  constructor(private readonly opts: RecordingSessionOptions) {
    this.format = opts.format ?? DEFAULT_WAV_FORMAT
    this.bytesPerSecond = (this.format.sampleRate * this.format.channels * this.format.bitsPerSample) / 8
  }

  get lectureId(): string {
    return this.opts.lectureId
  }

  get isStopped(): boolean {
    return !this.accepting
  }

  get error(): Error | null {
    return this.failed
  }

  /** Seconds of audio committed to disk plus the segment in progress. */
  get durationSec(): number {
    return this.elapsedBeforeCurrent + (this.writer ? this.writer.durationSec : 0)
  }

  get segmentCount(): number {
    return this.segments.length
  }

  get totalBytes(): number {
    return this.bytesWritten
  }

  get manifestEntries(): SegmentManifestEntry[] {
    return [...this.segments]
  }

  async start(): Promise<void> {
    const paths = lecturePaths(this.opts.lectureDir)
    await ensureDir(paths.audioDir)
    await this.writeManifest()
    this.enqueue(async () => {
      this.writer = await WavSegmentWriter.open(
        segmentPath(this.opts.lectureDir, this.nextIndex),
        this.format
      )
    })
    await this.queue
  }

  /**
   * Accept one PCM frame. Returns immediately; the write is queued. Callers
   * that need back-pressure can await `flush()`.
   */
  write(pcm: Buffer): void {
    if (!this.accepting || this.failed) return
    this.enqueue(async () => {
      if (!this.writer) throw new Error('Recording session received a frame before start()')
      await this.writer.append(pcm)
      this.bytesWritten += pcm.length

      // Roll over on a byte boundary rather than a timer: the segment length
      // then reflects audio actually captured, not wall-clock time, so a
      // stalled mic can't produce a segment that claims 45s of silence.
      if (this.writer.byteLength >= this.opts.segmentSeconds * this.bytesPerSecond) {
        await this.rollover()
      }
    })
  }

  /** Resolve once every queued write has hit disk. */
  async flush(): Promise<void> {
    await this.queue
  }

  /** Finalize the current segment and start the next one. */
  private async rollover(): Promise<void> {
    const writer = this.writer
    if (!writer) return
    const startSec = this.elapsedBeforeCurrent

    const { byteLength, durationSec, sha256 } = await writer.finalize()
    this.writer = null

    // A zero-length segment (mic produced nothing) is not worth keeping, but
    // we never delete it either — just don't claim it as audio.
    if (byteLength > 0) {
      const entry: SegmentManifestEntry = {
        index: this.nextIndex,
        relPath: segmentRelPath(this.nextIndex),
        startSec,
        durationSec,
        byteLength,
        sha256,
        createdAt: new Date().toISOString()
      }
      this.segments.push(entry)
      this.elapsedBeforeCurrent = startSec + durationSec
      await this.writeManifest()
      this.opts.onSegmentComplete?.(entry)
    }

    this.nextIndex += 1
    // Only the final rollover leaves the session without an open segment.
    if (!this.finalizing && !this.failed) {
      this.writer = await WavSegmentWriter.open(segmentPath(this.opts.lectureDir, this.nextIndex), this.format)
    }
  }

  /** Finalize everything and close out the manifest. */
  async stop(): Promise<SegmentManifestEntry[]> {
    if (!this.accepting) {
      await this.queue
      return this.manifestEntries
    }
    this.accepting = false
    this.enqueue(async () => {
      // Runs after every queued frame has been written, so it is safe here —
      // and only here — to declare the session finished.
      this.finalizing = true
      if (this.writer) await this.rollover()
      await this.writeManifest(true)
    })
    await this.queue
    return this.manifestEntries
  }

  /** Abandon the in-progress segment without patching its header. */
  async abort(): Promise<void> {
    this.accepting = false
    this.finalizing = true
    await this.queue.catch(() => undefined)
    if (this.writer) {
      await this.writer.abort()
      this.writer = null
    }
  }

  private async writeManifest(closed = false): Promise<void> {
    const manifest: SegmentManifest = {
      version: 1,
      lectureId: this.opts.lectureId,
      format: this.format,
      segmentSeconds: this.opts.segmentSeconds,
      segments: this.segments,
      ...(closed ? { closedAt: new Date().toISOString(), totalDurationSec: this.elapsedBeforeCurrent } : {})
    }
    await writeJsonAtomic(lecturePaths(this.opts.lectureDir).manifest, manifest)
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      // First failure wins: stop accepting frames rather than writing a
      // half-corrupt stream, and surface it so the UI can tell the student now
      // (mid-lecture) instead of at export time.
      if (!this.failed) {
        this.failed = error
        this.accepting = false
        this.opts.onError?.(error)
      }
    })
  }
}

/** Convert the manifest on disk into SegmentRecord rows (no DB dependency). */
export function manifestToSegmentRecords(
  lectureId: string,
  manifest: SegmentManifest
): Omit<SegmentRecord, 'id' | 'createdAt'>[] {
  return manifest.segments.map((s) => ({
    lectureId,
    index: s.index,
    relPath: s.relPath,
    startSec: s.startSec,
    durationSec: s.durationSec,
    byteLength: s.byteLength,
    sha256: s.sha256,
    verified: 'pending' as const
  }))
}

export function expectedFrameBytes(seconds: number): number {
  return (AUDIO_FORMAT.sampleRate * AUDIO_FORMAT.channels * AUDIO_FORMAT.bitsPerSample * seconds) / 8
}

export function segmentAbsolutePath(lectureDir: string, relPath: string): string {
  return path.join(lectureDir, ...relPath.split('/'))
}
