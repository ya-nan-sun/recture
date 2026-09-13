/**
 * A lecture's audio after transcription: one checksummed file instead of the
 * rolling segments it was recorded in.
 *
 * Segments exist so a crash mid-lecture costs seconds, not the lecture. Once a
 * lecture has been transcribed they are redundant — the assembled WAV holds
 * every sample — and keeping both doubled the space every lecture took. After a
 * successful pass the audio is folded into `audio/lecture-<hash>.wav` (or
 * `.opus` with compressed storage) and recorded in segments.json with its own
 * checksum. Recording into the lecture later adds new segments after it.
 *
 * Nothing is deleted until the new file is written, verified and recorded in
 * the manifest, and a lecture with any damaged audio is never compacted.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { AudioStorageFormat } from '@shared/types'
import { lecturePaths, readJson, writeJsonAtomic } from '../storage/paths'
import { concatWavFiles, readWavInfo, sha256File, type VerifyResult } from './wav'
import { isAudioArchive, segmentAbsolutePath, type AudioArchive, type SegmentManifest } from './recordingSession'
import { decodeToWav, encodeOpus, measureDecodedDuration } from './ffmpeg'

/** One verified piece of a lecture's audio, in timeline order. */
export interface LectureAudioSource {
  relPath: string
  absPath: string
  kind: 'archive' | 'segment'
  format: AudioStorageFormat
}

const DECODED_TEMP = 'archive-decoded.tmp.wav'
const OPUS_PARTIAL = 'lecture.opus.partial'
const ARCHIVE_FILE = /^lecture-[0-9a-f]{8,64}\.(wav|opus)$/
const SEGMENT_FILE = /^segment-(\d+)\.wav$/

/** Re-hash the archive and compare it with the checksum in the manifest. */
export async function verifyArchiveFile(absPath: string, archive: AudioArchive): Promise<VerifyResult> {
  let size: number
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) throw new Error('not a file')
    size = stat.size
  } catch {
    return { ok: false, reason: 'missing', detail: `Lecture audio file not found: ${absPath}` }
  }
  if (size === 0) return { ok: false, reason: 'unreadable', detail: 'Lecture audio file is empty.' }

  let actual: string
  try {
    actual = await sha256File(absPath)
  } catch (err) {
    return { ok: false, reason: 'unreadable', detail: `Could not read lecture audio: ${String(err)}` }
  }
  if (actual !== archive.sha256) {
    return {
      ok: false,
      reason: 'checksum_mismatch',
      detail: `Expected ${archive.sha256.slice(0, 12)}…, found ${actual.slice(0, 12)}…`
    }
  }

  if (archive.format === 'wav') {
    try {
      const info = await readWavInfo(absPath)
      return { ok: true, byteLength: info.dataByteLength, durationSec: info.durationSec }
    } catch (err) {
      return { ok: false, reason: 'unreadable', detail: `Checksum matched but header is invalid: ${String(err)}` }
    }
  }
  return { ok: true, byteLength: size, durationSec: archive.durationSec }
}

export interface AssembledAudio {
  /** The WAV to transcribe. */
  audioPath: string
  durationSec: number
}

/** Put a lecture's verified audio into a single WAV for transcription. */
export async function assembleLectureAudio(
  lectureDir: string,
  sources: LectureAudioSource[],
  options: { signal?: AbortSignal } = {}
): Promise<AssembledAudio> {
  if (sources.length === 0) throw new Error('Refusing to assemble an empty lecture: no verified audio')
  const paths = lecturePaths(lectureDir)

  // Remove a stale final.wav from a previous failed attempt so we can never
  // transcribe yesterday's audio for today's lecture.
  await fs.rm(paths.finalAudio, { force: true })

  const only = sources.length === 1 ? sources[0]! : null
  if (only && only.kind === 'archive' && only.format === 'wav') {
    // Already one verified WAV: transcribe it where it is rather than copying it.
    const info = await readWavInfo(only.absPath)
    return { audioPath: only.absPath, durationSec: info.durationSec }
  }

  const decodedPath = path.join(paths.audioDir, DECODED_TEMP)
  try {
    const parts: string[] = []
    for (const source of sources) {
      if (source.format === 'opus') {
        await decodeToWav(source.absPath, decodedPath, options)
        parts.push(decodedPath)
      } else {
        parts.push(source.absPath)
      }
    }
    const assembled = await concatWavFiles(parts, paths.finalAudio)
    return { audioPath: paths.finalAudio, durationSec: assembled.durationSec }
  } finally {
    await fs.rm(decodedPath, { force: true }).catch(() => undefined)
  }
}

export interface CompactOptions {
  lectureDir: string
  /** The WAV that was transcribed. It must hold every sample of the lecture. */
  audioPath: string
  format: AudioStorageFormat
  signal?: AbortSignal
}

export interface CompactResult {
  archive: AudioArchive
  /** File names removed from the lecture's audio folder. */
  removed: string[]
}

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Fold a transcribed lecture's audio into one checksummed file. */
export async function compactLectureAudio(options: CompactOptions): Promise<CompactResult> {
  const paths = lecturePaths(options.lectureDir)
  const manifest = await readJson<SegmentManifest>(paths.manifest)
  if (!manifest) throw new Error('This lecture has no audio manifest, so there is nothing to compact.')

  const current = isAudioArchive(manifest.archive) ? manifest.archive : null
  const segments = Array.isArray(manifest.segments) ? manifest.segments : []
  const covered = (current?.durationSec ?? 0) + segments.reduce((n, s) => n + s.durationSec, 0)

  // Only ever replace audio with a file that demonstrably holds all of it. Opus
  // decodes to within a frame of the original, so it gets a little more room.
  const info = await readWavInfo(options.audioPath)
  const tolerance = current?.format === 'opus' ? 0.1 : 0.05
  if (Math.abs(info.durationSec - covered) > tolerance) {
    throw new Error(
      `The assembled audio (${info.durationSec.toFixed(2)} s) does not match the lecture's recorded audio ` +
        `(${covered.toFixed(2)} s), so nothing was removed.`
    )
  }

  const throughIndex = segments.reduce((n, s) => Math.max(n, s.index), current?.throughIndex ?? 0)
  const now = new Date().toISOString()
  const absOf = (relPath: string): string => segmentAbsolutePath(options.lectureDir, relPath)

  let next: AudioArchive
  if (options.format === 'wav') {
    if (current?.format === 'wav' && segments.length === 0 && samePath(absOf(current.relPath), options.audioPath)) {
      next = current
    } else {
      const sha256 = await sha256File(options.audioPath)
      const relPath = `audio/lecture-${sha256.slice(0, 16)}.wav`
      const byteLength = (await fs.stat(options.audioPath)).size
      await fs.rename(options.audioPath, absOf(relPath))
      next = { relPath, format: 'wav', sha256, byteLength, durationSec: info.durationSec, throughIndex, createdAt: now }
    }
  } else if (current?.format === 'opus' && segments.length === 0) {
    next = current
  } else {
    const partial = path.join(paths.audioDir, OPUS_PARTIAL)
    try {
      await encodeOpus(options.audioPath, partial, { signal: options.signal })
      const decoded = await measureDecodedDuration(partial, { signal: options.signal })
      if (decoded === null || Math.abs(decoded - info.durationSec) > 0.25) {
        throw new Error(
          `The compressed audio did not play back at the right length (${decoded ?? 'unknown'} s, expected ` +
            `${info.durationSec.toFixed(2)} s), so the original was kept.`
        )
      }
      const sha256 = await sha256File(partial)
      const relPath = `audio/lecture-${sha256.slice(0, 16)}.opus`
      const byteLength = (await fs.stat(partial)).size
      await fs.rename(partial, absOf(relPath))
      next = { relPath, format: 'opus', sha256, byteLength, durationSec: info.durationSec, throughIndex, createdAt: now }
    } catch (err) {
      await fs.rm(partial, { force: true }).catch(() => undefined)
      throw err
    }
  }

  // Switch the manifest over in one atomic write. Only then is anything removed.
  const updated: SegmentManifest = {
    ...manifest,
    archive: next,
    segments: [],
    totalDurationSec: next.durationSec,
    closedAt: manifest.closedAt ?? now
  }
  await writeJsonAtomic(paths.manifest, updated)

  const removed = await removeReplacedAudio(options.lectureDir, next, {
    folded: new Set(next === current ? [] : segments.map((s) => path.basename(s.relPath))),
    previouslyThrough: current?.throughIndex ?? 0
  })
  return { archive: next, removed }
}

/**
 * Delete the files an archive replaces: the segments folded into it, earlier
 * archives, and transcription leftovers. Anything else in the folder — a
 * segment the manifest never listed, the student's own files — is left alone.
 * Also tidies up after a clean-up that was interrupted.
 */
async function removeReplacedAudio(
  lectureDir: string,
  archive: AudioArchive,
  scope: { folded: Set<string>; previouslyThrough: number }
): Promise<string[]> {
  const { audioDir, finalAudio } = lecturePaths(lectureDir)
  const keep = path.basename(archive.relPath)
  const leftovers = new Set([path.basename(finalAudio), DECODED_TEMP, OPUS_PARTIAL])
  const removed: string[] = []

  for (const name of await fs.readdir(audioDir).catch(() => [] as string[])) {
    const segment = SEGMENT_FILE.exec(name)
    const replaced =
      scope.folded.has(name) ||
      (segment !== null && Number(segment[1]) <= scope.previouslyThrough) ||
      (ARCHIVE_FILE.test(name) && name !== keep) ||
      leftovers.has(name)
    if (!replaced) continue
    try {
      await fs.rm(path.join(audioDir, name), { force: true })
      removed.push(name)
    } catch {
      // Picked up by the next compaction.
    }
  }
  return removed
}
