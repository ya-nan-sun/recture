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

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AudioStorageFormat, SegmentRecord } from '@shared/types'
import { AUDIO_FORMAT } from '@shared/types'
import { ensureDir, lecturePaths, readJson, segmentPath, segmentRelPath, writeJsonAtomic } from '../storage/paths'
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

/**
 * A lecture's audio once it has been transcribed: one checksummed file that
 * replaces the segments it was assembled from. See audio/archive.ts.
 */
export interface AudioArchive {
  /** `audio/lecture-<hash>.wav` or `.opus`, relative to the lecture folder. */
  relPath: string
  format: AudioStorageFormat
  sha256: string
  /** Size of the file on disk. */
  byteLength: number
  /** Covers the lecture from 0 to here; segments recorded later follow on. */
  durationSec: number
  /** Highest segment index folded in. New segments are numbered after it. */
  throughIndex: number
  createdAt: string
}

export interface SegmentManifest {
  version: 1
  lectureId: string
  format: WavFormat
  segmentSeconds: number
  /** The start of the lecture, folded into one file after transcription. */
  archive?: AudioArchive
  /** Audio recorded since the archive — or all of it, before the first transcription. */
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
  /** Discards incoming frames without ending the lecture (a mid-lecture break). */
  private paused = false
  /** Seconds of audio the lecture already had before this session started. */
  private initialDurationSec = 0
  /** The lecture's archived audio, carried through every manifest this session writes. */
  private archive: AudioArchive | null = null
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

  get isPaused(): boolean {
    return this.paused
  }

  /** Audio already in the lecture when this session began, when resuming into it. */
  get offsetSec(): number {
    return this.initialDurationSec
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
    await this.adoptExistingAudio()
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
   * Continue a lecture that already has audio instead of overwriting it.
   *
   * Recording into such a lecture used to restart numbering at segment 1: it
   * rewrote segments.json with an empty list, orphaning every existing segment
   * from its index, then failed to open segment-0001.wav because that file
   * already existed.
   */
  private async adoptExistingAudio(): Promise<void> {
    const paths = lecturePaths(this.opts.lectureDir)
    const manifest = await readJson<SegmentManifest>(paths.manifest)
    const listed = manifest?.segments
    const existing = (Array.isArray(listed) ? listed : []).filter(isManifestEntry).sort((a, b) => a.index - b.index)
    this.segments.splice(0, this.segments.length, ...existing)
    const archive = manifest?.archive
    this.archive = isAudioArchive(archive) ? archive : null

    // Continue the timeline from where the existing audio ends, archive included.
    this.initialDurationSec = existing.reduce(
      (end, s) => Math.max(end, s.startSec + s.durationSec),
      this.archive?.durationSec ?? 0
    )
    this.elapsedBeforeCurrent = this.initialDurationSec

    // Number past every segment file on disk, listed in the manifest or not,
    // and past everything folded into the archive, so the exclusive open can
    // never collide with an earlier file.
    let highest = existing.reduce((n, s) => Math.max(n, s.index), this.archive?.throughIndex ?? 0)
    const files = await fs.readdir(paths.audioDir).catch(() => [] as string[])
    for (const name of files) {
      if (!name.startsWith('segment-') || !name.endsWith('.wav')) continue
      const index = Number(name.slice('segment-'.length, name.length - '.wav'.length))
      if (Number.isInteger(index)) highest = Math.max(highest, index)
    }
    this.nextIndex = highest + 1
  }

  /**
   * Stop taking frames without ending the lecture: a mid-lecture break. The
   * segment in progress is finalized first, so a long break never leaves
   * unchecksummed audio sitting in an open file.
   */
  async pause(): Promise<void> {
    if (!this.accepting || this.failed || this.paused) return
    this.paused = true
    this.enqueue(async () => {
      if (this.writer && this.writer.byteLength > 0) await this.rollover()
    })
    await this.queue
  }

  /** Take frames again after pause(). */
  resume(): void {
    if (!this.accepting || this.failed) return
    this.paused = false
  }

  /**
   * Accept one PCM frame. Returns immediately; the write is queued. Callers
   * that need back-pressure can await `flush()`.
   */
  write(pcm: Buffer): void {
    if (!this.accepting || this.failed || this.paused) return
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

    // Only segments that actually contain audio are claimed in the manifest.
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
    } else {
      // Header only, no audio: a stop or pause that landed right after a
      // rollover. Remove it rather than leave empty files behind.
      await fs.rm(writer.filePath, { force: true }).catch(() => undefined)
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
      ...(this.archive ? { archive: this.archive } : {}),
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

function isManifestEntry(value: unknown): value is SegmentManifestEntry {
  const s = value as SegmentManifestEntry
  return (
    !!s &&
    Number.isInteger(s.index) &&
    typeof s.relPath === 'string' &&
    typeof s.sha256 === 'string' &&
    Number.isFinite(s.startSec) &&
    Number.isFinite(s.durationSec) &&
    Number.isFinite(s.byteLength)
  )
}

/**
 * Validate an archive entry read from disk. The path must name a lecture audio
 * file inside the lecture's own audio folder, so a hand-edited or malicious
 * manifest can never point the app at another file.
 */
export function isAudioArchive(value: unknown): value is AudioArchive {
  const a = value as AudioArchive
  return (
    !!a &&
    typeof a.relPath === 'string' &&
    /^audio\/lecture-[0-9a-f]{8,64}\.(wav|opus)$/.test(a.relPath) &&
    (a.format === 'wav' || a.format === 'opus') &&
    a.relPath.endsWith(`.${a.format}`) &&
    typeof a.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(a.sha256) &&
    Number.isFinite(a.durationSec) &&
    a.durationSec >= 0 &&
    Number.isInteger(a.throughIndex) &&
    a.throughIndex >= 0
  )
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
