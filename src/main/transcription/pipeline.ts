/**
 * The final transcription pass.
 *
 * Order matters, and it is chosen so that a failure at any step leaves the
 * recording recoverable:
 *
 *   1. Verify every segment's checksum. Corrupt segments are excluded and
 *      flagged — never silently dropped, never silently included.
 *   2. Assemble the verified segments into final.wav.
 *   3. Transcribe with retry/backoff.
 *   4. Run the conservative glossary correction step (suggestions only).
 *   5. Write transcript.json atomically, then update the index.
 *
 * If step 3 or 4 ultimately fails, the audio is left intact and the lecture is
 * marked `needs_transcription` so it can be retried later. A lecture is never
 * deleted or truncated by this pipeline.
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
import { lecturePaths, writeJsonAtomic } from '../storage/paths'
import { concatWavFiles, verifySegmentFile } from '../audio/wav'
import { segmentAbsolutePath } from '../audio/recordingSession'
import type { Repos } from '../db/repos'
import type { BatchTranscriber } from './types'
import { PermanentTranscriptionError } from './types'
import { DEFAULT_RETRY, withRetry } from './retry'

export interface VerificationOutcome {
  verified: { relPath: string; absPath: string }[]
  corrupt: { relPath: string; reason: SegmentVerification; detail: string }[]
}

/** Re-hash every segment of a lecture and record the result. */
export async function verifyLectureSegments(repos: Repos, lecture: LectureRecord): Promise<VerificationOutcome> {
  const segments = repos.segments.listByLecture(lecture.id)
  const outcome: VerificationOutcome = { verified: [], corrupt: [] }

  for (const segment of segments) {
    const absPath = segmentAbsolutePath(lecture.dirPath, segment.relPath)
    const result = await verifySegmentFile(absPath, segment.sha256)
    if (result.ok) {
      repos.segments.setVerification(segment.id, 'ok')
      outcome.verified.push({ relPath: segment.relPath, absPath })
    } else {
      repos.segments.setVerification(segment.id, result.reason)
      outcome.corrupt.push({ relPath: segment.relPath, reason: result.reason, detail: result.detail })
    }
  }
  return outcome
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
  report('verifying', 'Verifying audio segments…', 0)
  const verification = await verifyLectureSegments(repos, lecture)

  repos.lectures.update(lecture.id, {
    segmentCount: verification.verified.length + verification.corrupt.length,
    corruptSegmentCount: verification.corrupt.length
  })

  if (verification.verified.length === 0) {
    const detail =
      verification.corrupt.length > 0
        ? `All ${verification.corrupt.length} audio segment(s) failed verification.`
        : 'No audio segments were recorded for this lecture.'
    repos.lectures.setStatus(lecture.id, 'needs_attention', detail)
    report('failed', detail)
    throw new PermanentTranscriptionError(detail)
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
  report('assembling', 'Assembling verified audio…', 0.1)
  repos.lectures.setStatus(lecture.id, 'assembling', null)

  // Remove a stale final.wav from a previous failed attempt so we can never
  // transcribe yesterday's audio for today's lecture.
  await fs.rm(paths.finalAudio, { force: true })
  const assembled = await concatWavFiles(
    verification.verified.map((s) => s.absPath),
    paths.finalAudio
  )

  // --- 3. transcribe -------------------------------------------------------
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
        audioPath: paths.finalAudio,
        language: settings.language,
        keyterms,
        signal: deps.signal,
        onProgress: (progress, message) =>
          report('transcribing', message, progress === null ? null : 0.2 + progress * 0.6, attempt)
      })
    },
    {
      ...DEFAULT_RETRY,
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
    durationSec: result.durationSec || assembled.durationSec,
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

  report('done', 'Transcript ready.', 1)
  return { transcript, corruptSegments: verification.corrupt }
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
