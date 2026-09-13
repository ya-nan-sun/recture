/**
 * Import an audio or video file as a lecture's audio.
 *
 * The file is decoded to the app's own format and fed through the same
 * RecordingSession a live recording uses, so an imported lecture lands on disk
 * exactly like a recorded one — rolling checksummed segments and a manifest —
 * and every later step (verification, transcription, crash recovery, rescan)
 * treats it the same way. The source file is only ever read.
 */

import * as fs from 'node:fs/promises'
import { AUDIO_FORMAT } from '@shared/types'
import { RecordingSession, type SegmentManifestEntry } from './recordingSession'
import { decodeToPcm } from './ffmpeg'

const BYTES_PER_SECOND = (AUDIO_FORMAT.sampleRate * AUDIO_FORMAT.channels * AUDIO_FORMAT.bitsPerSample) / 8

export class ImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportError'
  }
}

export interface ImportTick {
  processedSec: number
  /** The file's length, when ffmpeg could tell. */
  totalSec: number | null
}

export interface ImportAudioOptions {
  lectureId: string
  lectureDir: string
  segmentSeconds: number
  sourcePath: string
  signal?: AbortSignal
  onProgress?: (tick: ImportTick) => void
  onSegmentComplete?: (entry: SegmentManifestEntry) => void
}

export interface ImportAudioResult {
  durationSec: number
  segments: SegmentManifestEntry[]
}

export async function importAudioFile(options: ImportAudioOptions): Promise<ImportAudioResult> {
  const stat = await fs.stat(options.sourcePath).catch(() => null)
  if (!stat || !stat.isFile()) throw new ImportError('The file could not be found.')
  if (stat.size === 0) throw new ImportError('That file is empty.')

  const failure: { error: Error | null } = { error: null }
  const session = new RecordingSession({
    lectureId: options.lectureId,
    lectureDir: options.lectureDir,
    segmentSeconds: options.segmentSeconds,
    onSegmentComplete: options.onSegmentComplete,
    onError: (error) => {
      failure.error = error
    }
  })
  await session.start()

  let totalSec: number | null = null
  let bytes = 0
  try {
    await decodeToPcm(
      options.sourcePath,
      async (pcm) => {
        session.write(pcm)
        // Wait for the disk before taking more, so memory stays flat.
        await session.flush()
        if (failure.error) throw failure.error
        bytes += pcm.length
        options.onProgress?.({ processedSec: bytes / BYTES_PER_SECOND, totalSec })
      },
      {
        signal: options.signal,
        onDuration: (seconds) => {
          totalSec = seconds
        }
      }
    )
  } catch (err) {
    await session.abort()
    throw err
  }

  const segments = await session.stop()
  if (failure.error) throw failure.error
  if (bytes === 0) throw new ImportError("That file doesn't contain any audio.")
  return { durationSec: session.durationSec, segments }
}
