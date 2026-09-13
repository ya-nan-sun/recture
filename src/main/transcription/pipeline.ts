/**
 * The final transcription pass.
 *
 * Order matters, and it is chosen so that a failure at any step leaves the
 * recording recoverable:
 *
 *   1. Verify the lecture's audio: the archived file from an earlier pass, if
 *      there is one, and every segment recorded since. Anything damaged is
 *      excluded and flagged — never silently dropped, never silently included.
 *   2. Assemble the verified audio into final.wav.
 *   3. Transcribe with retry/backoff.
 *   4. Run the conservative glossary correction step (suggestions only).
 *   5. Write transcript.json atomically, then update the index.
 *   6. Fold the audio into one checksummed file and remove the now-redundant
 *      segments — only when nothing was damaged, and only once the new file is
 *      verified and recorded in the manifest.
 *
 * If step 3 or 4 ultimately fails, the audio is left intact and the lecture is
 * marked `needs_transcription` so it can be retried later. Step 6 failing
 * costs disk space, never audio. A lecture is never truncated by this pipeline.
 */

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type {
  AppSettings,
  ClassRecord,
  GlossaryTerm,
  LectureRecord,
  SegmentVerification,
  TranscriptFile,
  TranscriptionProgress
} from '@shared/types'
import { findCorrectionSuggestions, glossaryKeyterms } from '@shared/correction'
import { lecturePaths, readJson, writeJsonAtomic } from '../storage/paths'
import { verifySegmentFile } from '../audio/wav'
import { isAudioArchive, segmentAbsolutePath, type AudioArchive, type SegmentManifest } from '../audio/recordingSession'
import {
  assembleLectureAudio,
  compactLectureAudio,
  verifyArchiveFile,
  type LectureAudioSource
} from '../audio/archive'
import type { Repos } from '../db/repos'
import type { BatchTranscriber } from './types'
import { NoUsableAudioError, throwIfAborted } from './types'
import { DEFAULT_RETRY, withRetry } from './retry'

export interface VerificationOutcome {
  /** In timeline order: the archive first, then segments recorded since. */
  verified: LectureAudioSource[]
  corrupt: { relPath: string; reason: SegmentVerification; detail: string }[]
}

/** Re-hash all of a lecture's audio and record the result. */
export async function verifyLectureSegments(repos: Repos, lecture: LectureRecord): Promise<VerificationOutcome> {
  const outcome: VerificationOutcome = { verified: [], corrupt: [] }

  const manifest = await readJson<SegmentManifest>(lecturePaths(lecture.dirPath).manifest)
  const listed = manifest?.archive
  const archive = isAudioArchive(listed) ? listed : null
  if (archive) {
    const absPath = segmentAbsolutePath(lecture.dirPath, archive.relPath)
    const result = await verifyArchiveFile(absPath, archive)
    if (result.ok) {
      outcome.verified.push({ relPath: archive.relPath, absPath, kind: 'archive', format: archive.format })
    } else {
      outcome.corrupt.push({ relPath: archive.relPath, reason: result.reason, detail: result.detail })
    }
  }

  for (const segment of repos.segments.listByLecture(lecture.id)) {
    // Already folded into the archive; the row outlived an interrupted clean-up.
    if (archive && segment.index <= archive.throughIndex) continue
    const absPath = segmentAbsolutePath(lecture.dirPath, segment.relPath)
    const result = await verifySegmentFile(absPath, segment.sha256)
    if (result.ok) {
      repos.segments.setVerification(segment.id, 'ok')
      outcome.verified.push({ relPath: segment.relPath, absPath, kind: 'segment', format: 'wav' })
    } else {
      repos.segments.setVerification(segment.id, result.reason)
      outcome.corrupt.push({ relPath: segment.relPath, reason: result.reason, detail: result.detail })
    }
  }
  return outcome
}

function noUsableAudioDetail(corrupt: VerificationOutcome['corrupt']): string {
  if (corrupt.length === 0) return 'No audio segments were recorded for this lecture.'
  if (corrupt.length === 1 && corrupt[0]!.relPath.startsWith('audio/lecture-')) {
    return "The lecture's audio file failed its integrity check."
  }
  return `All ${corrupt.length} audio segment(s) failed verification.`
}

export interface FinalPassDeps {
  repos: Repos
  settings: AppSettings
  transcriber: BatchTranscriber
  glossary: GlossaryTerm[]
  onProgress: (progress: TranscriptionProgress) => void
  signal?: AbortSignal
}

export interface FinalPassResult {
  transcript: TranscriptFile
  corruptSegments: VerificationOutcome['corrupt']
  /** The single file the audio was folded into, or null if it was not compacted. */
  archive: AudioArchive | null
}

export async function runFinalPass(
  klass: ClassRecord,
  lecture: LectureRecord,
  deps: FinalPassDeps
): Promise<FinalPassResult> {
  const { repos, settings, transcriber, glossary, onProgress } = deps
  const paths = lecturePaths(lecture.dirPath)

  const report = (
    phase: TranscriptionProgress['phase'],
    message: string,
    progress: number | null = null,
    attempt?: number
  ): void => onProgress({ lectureId: lecture.id, phase, message, progress, attempt })

  // --- 1. verify -----------------------------------------------------------
  throwIfAborted(deps.signal)
  report('verifying', 'Verifying audio…', 0)
  const verification = await verifyLectureSegments(repos, lecture)

  repos.lectures.update(lecture.id, {
    segmentCount: verification.verified.filter((v) => v.kind === 'segment').length + verification.corrupt.length,
    corruptSegmentCount: verification.corrupt.length
  })

  if (verification.verified.length === 0) {
    const detail = noUsableAudioDetail(verification.corrupt)
    repos.lectures.setStatus(lecture.id, 'needs_attention', detail)
    report('failed', detail)
    throw new NoUsableAudioError(detail)
  }

  if (verification.corrupt.length > 0) {
    // Proceed with what is intact, but keep the damage visible.
    repos.lectures.setStatus(
      lecture.id,
      'transcribing',
      `${verification.corrupt.length} audio segment(s) failed verification and were excluded.`
    )
  }

  // --- 2. assemble ---------------------------------------------------------
  throwIfAborted(deps.signal)
  report('assembling', 'Assembling verified audio…', 0.1)
  repos.lectures.setStatus(lecture.id, 'assembling', null)
  const audio = await assembleLectureAudio(lecture.dirPath, verification.verified, { signal: deps.signal })

  // --- 3. transcribe -------------------------------------------------------
  throwIfAborted(deps.signal)
  repos.lectures.setStatus(lecture.id, 'transcribing', null)
  const keyterms = glossaryKeyterms(glossary)

  const result = await withRetry(
    async (attempt) => {
      report(
        'transcribing',
        attempt === 1
          ? `Transcribing with ${transcriber.label}…`
          : `Transcribing with ${transcriber.label} (attempt ${attempt})…`,
        0.2,
        attempt
      )
      return transcriber.transcribe({
        audioPath: audio.audioPath,
        language: settings.language,
        keyterms,
        signal: deps.signal,
        onProgress: (progress, message) =>
          report('transcribing', message, progress === null ? null : 0.2 + progress * 0.6, attempt)
      })
    },
    {
      ...DEFAULT_RETRY,
      signal: deps.signal,
      onRetry: (attempt, delayMs, error) =>
        report(
          'transcribing',
          `Attempt ${attempt} failed (${error.message}). Retrying in ${Math.round(delayMs / 1000)}s…`,
          null,
          attempt
        )
    }
  )

  // --- 4. correction suggestions ------------------------------------------
  report('correcting', 'Checking transcript against the class glossary…', 0.85)
  const suggestions = findCorrectionSuggestions(
    result.segments,
    glossary.map((g) => ({ term: g.term, note: g.note })),
    {
      confidenceThreshold: settings.correctionConfidenceThreshold,
      similarityThreshold: settings.correctionSimilarityThreshold,
      strongSimilarity: 0.9,
      maxSuggestions: 300
    }
  )

  // --- 5. persist ----------------------------------------------------------
  report('writing', 'Saving transcript…', 0.95)
  const now = new Date().toISOString()
  const transcript: TranscriptFile = {
    version: 1,
    lectureId: lecture.id,
    classId: klass.id,
    className: klass.name,
    lectureTitle: lecture.title,
    recordedAt: lecture.recordedAt,
    durationSec: result.durationSec || audio.durationSec,
    source: {
      pass: 'final',
      provider: result.provider,
      model: result.model,
      language: result.language
    },
    createdAt: now,
    updatedAt: now,
    segments: result.segments,
    suggestions,
    excludedAudioSegments: verification.corrupt.map((c) => ({ relPath: c.relPath, reason: c.reason }))
  }

  await writeJsonAtomic(paths.transcript, transcript)

  repos.lectures.update(lecture.id, {
    durationSec: transcript.durationSec,
    status: verification.corrupt.length > 0 ? 'needs_attention' : 'complete',
    statusDetail:
      verification.corrupt.length > 0
        ? `Transcribed, but ${verification.corrupt.length} audio segment(s) failed verification and were excluded.`
        : null,
    transcriptSource: `${result.provider} · ${result.model}`,
    transcriptPass: 'final'
  })

  repos.lectures.indexForSearch(
    lecture.id,
    klass.name,
    lecture.title,
    transcript.segments.map((s) => s.text).join(' ')
  )

  // --- 6. fold the audio into one file -------------------------------------
  let archive: AudioArchive | null = null
  if (verification.corrupt.length === 0) {
    report('writing', 'Tidying up audio files…', 0.98)
    try {
      archive = (
        await compactLectureAudio({
          lectureDir: lecture.dirPath,
          audioPath: audio.audioPath,
          format: settings.audioStorage === 'opus' ? 'opus' : 'wav',
          signal: deps.signal
        })
      ).archive
      repos.segments.removeByLecture(lecture.id)
      repos.lectures.update(lecture.id, { segmentCount: 0 })
    } catch (err) {
      // Every file is still in place; the next successful pass tries again.
      console.warn(`Audio for “${lecture.title}” was not compacted: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  report('done', 'Transcript ready.', 1)
  return { transcript, corruptSegments: verification.corrupt, archive }
}

/**
 * Called when the final pass fails for good. Keeps every byte of audio and
 * marks the lecture so the UI can offer a retry — the live draft, if one
 * exists, is promoted to a clearly-labelled fallback transcript.
 */
export async function handleFinalPassFailure(
  repos: Repos,
  lecture: LectureRecord,
  error: Error,
  onProgress: (progress: TranscriptionProgress) => void
): Promise<void> {
  if (error instanceof NoUsableAudioError) {
    // The pipeline already marked this lecture needs_attention with the real
    // reason. Overwriting that with "the recording is safe, retry any time"
    // would be untrue: there is no usable audio to retry with.
    onProgress({ lectureId: lecture.id, phase: 'failed', message: error.message, progress: null })
    return
  }

  const paths = lecturePaths(lecture.dirPath)
  const hasLiveDraft = await fs
    .stat(paths.liveTranscript)
    .then(() => true)
    .catch(() => false)

  let detail = `Final transcription failed: ${error.message}`
  if (hasLiveDraft) {
    detail += ' The live draft was kept as a rough fallback — it is less accurate than a final pass.'
  }
  detail += ' The recording is safe; you can retry transcription at any time.'

  repos.lectures.update(lecture.id, {
    status: 'needs_transcription',
    statusDetail: detail,
    transcriptPass: hasLiveDraft ? 'live-draft' : null,
    transcriptSource: hasLiveDraft ? 'live draft (fallback)' : null
  })

  onProgress({ lectureId: lecture.id, phase: 'failed', message: detail, progress: null })
}

/** Absolute path helper used by the IPC layer for playback. */
export function finalAudioPath(lectureDir: string): string {
  return path.join(lectureDir, 'audio', 'final.wav')
}
