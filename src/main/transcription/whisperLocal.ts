/**
 * Local final pass: faster-whisper in a Python subprocess.
 *
 * This is the default provider because it keeps lecture audio on the device
 * entirely. It costs nothing per hour and works offline, at the price of a
 * one-off model download and slower-than-realtime transcription on CPU.
 */

import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ProviderAvailability, TranscriptSegment } from '@shared/types'
import type { BatchTranscriber, TranscriptionRequest, TranscriptionResult } from './types'
import {
  PermanentTranscriptionError,
  TransientTranscriptionError,
  TranscriptionAbortedError,
  throwIfAborted
} from './types'

const execFileAsync = promisify(execFile)

export interface WhisperLocalOptions {
  scriptPath: () => string
  pythonPath: () => string
  /**
   * Getters, not values: the student can change the model in Settings while
   * the app is running, and the next transcription must use the new one.
   * Capturing these at construction silently pinned them until restart.
   */
  model: () => string
  computeType: () => string
}

interface WhisperEvent {
  event: 'progress' | 'segment' | 'done' | 'error'
  progress?: number | null
  message?: string
  start?: number
  end?: number
  text?: string
  words?: { word: string; start: number; end: number; confidence: number }[]
  duration?: number
  language?: string
  model?: string
  permanent?: boolean
}

/** Python interpreters to try, in order, when none is configured. */
const PYTHON_CANDIDATES = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']

export async function findPython(preferred?: string): Promise<string | null> {
  const candidates = preferred ? [preferred, ...PYTHON_CANDIDATES] : PYTHON_CANDIDATES
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 8000, windowsHide: true })
      return candidate
    } catch {
      // try the next one
    }
  }
  return null
}

export class WhisperLocalTranscriber implements BatchTranscriber {
  readonly id = 'whisper-local' as const
  readonly label = 'faster-whisper (on this device)'
  readonly sendsAudioOffDevice = false

  constructor(private readonly options: WhisperLocalOptions) {}

  async checkAvailability(): Promise<ProviderAvailability> {
    const python = await findPython(this.options.pythonPath())
    if (!python) {
      return {
        id: this.id,
        available: false,
        detail: 'Python was not found. Install Python 3, then `pip install faster-whisper`.',
        sendsAudioOffDevice: false
      }
    }
    try {
      await execFileAsync(python, ['-c', 'import faster_whisper'], { timeout: 30_000, windowsHide: true })
      return {
        id: this.id,
        available: true,
        detail: `Ready (${python}, model ${this.options.model()}). Audio stays on this device.`,
        sendsAudioOffDevice: false
      }
    } catch {
      return {
        id: this.id,
        available: false,
        detail: `Found ${python}, but faster-whisper is not installed. Run: ${python} -m pip install faster-whisper`,
        sendsAudioOffDevice: false
      }
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    // Never start Python for a job that has already been stopped.
    throwIfAborted(request.signal)
    const python = await findPython(this.options.pythonPath())
    if (!python) throw new PermanentTranscriptionError('Python was not found on this system.')

    const requestFile = path.join(os.tmpdir(), `recture-whisper-${randomUUID()}.json`)
    await fs.writeFile(
      requestFile,
      JSON.stringify({
        audioPath: request.audioPath,
        model: this.options.model(),
        computeType: this.options.computeType(),
        language: request.language,
        keyterms: request.keyterms
      }),
      'utf8'
    )

    try {
      return await this.run(python, requestFile, request)
    } finally {
      await fs.rm(requestFile, { force: true })
    }
  }

  private run(python: string, requestFile: string, request: TranscriptionRequest): Promise<TranscriptionResult> {
    return new Promise<TranscriptionResult>((resolve, reject) => {
      const child = spawn(python, [this.options.scriptPath(), requestFile], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      // Run below normal priority, so a long transcription never starves a
      // recording happening at the same time.
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        // Not permitted everywhere; transcription still works at normal priority.
      }

      const segments: TranscriptSegment[] = []
      let durationSec = 0
      let language = request.language
      let model = this.options.model()
      let done = false
      let failure: Error | null = null
      let stdoutTail = ''
      let stderrTail = ''

      // Stopping must actually end the Python process: quitting the app used to
      // leave it transcribing, at full CPU, with no window open.
      const onAbort = (): void => {
        child.kill()
        reject(new TranscriptionAbortedError('Transcription was stopped.'))
      }
      if (request.signal?.aborted) {
        onAbort()
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })

      const handleEvent = (event: WhisperEvent): void => {
        switch (event.event) {
          case 'progress':
            request.onProgress?.(event.progress ?? null, event.message ?? 'Transcribing…')
            break
          case 'segment': {
            const words = (event.words ?? []).map((w) => ({
              word: w.word,
              start: w.start,
              end: w.end,
              confidence: w.confidence
            }))
            const text = (event.text ?? '').trim()
            if (!text) break
            segments.push({
              id: randomUUID(),
              start: event.start ?? 0,
              end: event.end ?? 0,
              speaker: null,
              text,
              // Whisper can return a segment without word timings; synthesize
              // them so the correction step still has something to gate on.
              words:
                words.length > 0
                  ? words
                  : text.split(/\s+/).map((word, i, arr) => {
                      const span = ((event.end ?? 0) - (event.start ?? 0)) / Math.max(1, arr.length)
                      return {
                        word,
                        start: (event.start ?? 0) + i * span,
                        end: (event.start ?? 0) + (i + 1) * span,
                        confidence: 1
                      }
                    })
            })
            break
          }
          case 'done':
            done = true
            durationSec = event.duration ?? 0
            language = event.language ?? language
            model = event.model ?? model
            break
          case 'error':
            failure = event.permanent
              ? new PermanentTranscriptionError(event.message ?? 'Local transcription failed.')
              : new TransientTranscriptionError(event.message ?? 'Local transcription failed.')
            break
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutTail += chunk
        // Events are newline-delimited JSON; hold any partial trailing line.
        const lines = stdoutTail.split('\n')
        stdoutTail = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            handleEvent(JSON.parse(trimmed) as WhisperEvent)
          } catch {
            // Ignore non-JSON chatter (model download progress bars etc.).
          }
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-4000)
      })

      child.on('error', (err) => {
        request.signal?.removeEventListener('abort', onAbort)
        reject(new PermanentTranscriptionError(`Could not start Python: ${err.message}`))
      })

      child.on('close', (code) => {
        request.signal?.removeEventListener('abort', onAbort)
        if (failure) return reject(failure)
        if (!done || segments.length === 0) {
          const detail = stderrTail.trim().slice(-600)
          return reject(
            code === 0
              ? new PermanentTranscriptionError(
                  `Local transcription produced no text. The audio may be silent.${detail ? ` (${detail})` : ''}`
                )
              : new TransientTranscriptionError(
                  `Local transcription exited with code ${code}.${detail ? ` ${detail}` : ''}`
                )
          )
        }
        resolve({ provider: 'whisper-local', model, language, durationSec, segments })
      })
    })
  }
}
