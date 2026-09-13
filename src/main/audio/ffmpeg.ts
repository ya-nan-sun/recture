/**
 * ffmpeg, for the jobs the app's own WAV code does not do: reading other
 * people's audio and video files (phone voice memos, Zoom and Panopto
 * downloads) and compressing finished lectures to Opus.
 *
 * Never on the recording path. Capture, checksums and assembly stay in plain
 * Node, so a missing or broken ffmpeg can never cost a lecture.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import type { Readable } from 'node:stream'
import ffmpegStatic from 'ffmpeg-static'

export class FfmpegError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FfmpegError'
  }
}

export class FfmpegAbortedError extends Error {
  constructor(message = 'Stopped.') {
    super(message)
    this.name = 'FfmpegAbortedError'
  }
}

/** Inside a packaged app the binary lives next to app.asar, not inside it. */
export function unpackedPath(binaryPath: string): string {
  return binaryPath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

export function ffmpegPath(): string {
  const override = process.env.RECTURE_FFMPEG?.trim()
  const candidate = override || (ffmpegStatic ? unpackedPath(ffmpegStatic) : null)
  if (!candidate || !fs.existsSync(candidate)) {
    throw new FfmpegError('ffmpeg is missing from this installation, so audio files cannot be imported or compressed.')
  }
  return candidate
}

/** `01:02:03.45` → seconds. */
export function parseClock(text: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

/** The input's length, from the `Duration: 00:01:02.50` line ffmpeg prints. */
export function parseInputDuration(stderr: string): number | null {
  const match = /Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/.exec(stderr)
  return match ? parseClock(match[1]!) : null
}

/** How far processing got, from the last `time=00:00:05.12` report. */
export function parseLastTime(stderr: string): number | null {
  const pattern = /time=\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/g
  let last: string | null = null
  for (let match = pattern.exec(stderr); match; match = pattern.exec(stderr)) last = match[1]!
  return last === null ? null : parseClock(last)
}

/** Turn ffmpeg's error output into something a student can act on. */
export function describeFfmpegFailure(stderr: string, exitCode: number | null): string {
  if (/Invalid data found when processing input|could not find codec parameters|moov atom not found|Failed to read frame size/i.test(stderr)) {
    return "That file isn't audio or video Recture can read. It may be damaged, or not a media file."
  }
  if (/matches no streams|does not contain any stream/i.test(stderr)) {
    return "That file doesn't have an audio track."
  }
  if (/No such file or directory/i.test(stderr)) return 'The file could not be found.'
  if (/Permission denied/i.test(stderr)) return 'Recture was not allowed to read that file.'
  if (/No space left on device/i.test(stderr)) return 'The drive is full.'
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const lastLine = lines[lines.length - 1]
  return `ffmpeg failed${exitCode === null ? '' : ` (exit ${exitCode})`}${lastLine ? `: ${lastLine}` : '.'}`
}

export interface RunFfmpegOptions {
  signal?: AbortSignal
  /** Receive stdout. Pause the stream for back-pressure; destroy it to give up. */
  onStdout?: (chunk: Buffer, stream: Readable) => void
  onStderr?: (text: string) => void
}

const STDERR_KEEP = 16_000

export function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const { signal } = options
    if (signal?.aborted) {
      reject(new FfmpegAbortedError())
      return
    }
    let binary: string
    try {
      binary = ffmpegPath()
    } catch (err) {
      reject(err)
      return
    }

    const child = spawn(binary, ['-hide_banner', '-nostdin', ...args], {
      windowsHide: true,
      stdio: ['ignore', options.onStdout ? 'pipe' : 'ignore', 'pipe']
    })

    // Keep the start (input details, including the duration) and a rolling end
    // (the error, or the final progress report).
    let head = ''
    let tail = ''
    let settled = false
    const settle = (error: Error | null): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ stderr: head + tail })
    }
    let aborted = false
    const onAbort = (): void => {
      aborted = true
      signal?.removeEventListener('abort', onAbort)
      if (child.exitCode !== null || child.signalCode !== null) {
        settle(new FfmpegAbortedError())
        return
      }
      // Discard output still waiting to be read, so a paused pipe cannot keep
      // the process alive.
      child.stdout?.destroy()
      child.kill()
      // Reject only once the process has actually exited. Windows keeps its
      // files open for a moment after it is told to stop, and callers delete
      // or reuse those files as soon as this rejects.
      const fallback = setTimeout(() => settle(new FfmpegAbortedError()), 5000)
      child.once('exit', () => {
        clearTimeout(fallback)
        settle(new FfmpegAbortedError())
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => {
      if (head.length < STDERR_KEEP) head += text
      else tail = (tail + text).slice(-STDERR_KEEP)
      options.onStderr?.(text)
    })

    if (options.onStdout && child.stdout) {
      const stream = child.stdout
      stream.on('data', (chunk: Buffer) => options.onStdout!(chunk, stream))
      // A receiver that gives up destroys the stream; ffmpeg then exits on EPIPE.
      stream.on('error', () => undefined)
    }

    child.on('error', (err) => {
      if (!aborted) settle(new FfmpegError(`Could not run ffmpeg: ${err.message}`))
    })
    child.on('close', (code) => {
      // A cancelled run settles in onAbort, once the process has exited.
      if (aborted) return
      if (code === 0) settle(null)
      else settle(new FfmpegError(describeFfmpegFailure(head + tail, code)))
    })
  })
}

/**
 * Decode any audio or video file to 16 kHz mono 16-bit PCM, handing it over in
 * chunks. The next chunk is not read until `sink` has finished with the last,
 * so a three-hour file never piles up in memory.
 */
export async function decodeToPcm(
  input: string,
  sink: (pcm: Buffer) => Promise<void>,
  options: { signal?: AbortSignal; onDuration?: (seconds: number | null) => void } = {}
): Promise<void> {
  let carry: Buffer | null = null
  let pending: Promise<void> = Promise.resolve()
  let sinkError: unknown = null
  let durationKnown = false
  let stderrSoFar = ''

  const deliver = async (pcm: Buffer): Promise<void> => {
    if (sinkError !== null || pcm.length === 0) return
    await sink(pcm)
  }

  try {
    await runFfmpeg(
      [
        '-nostats',
        '-i', input,
        '-map', '0:a:0',
        '-vn', '-sn', '-dn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'pcm_s16le',
        '-f', 's16le',
        'pipe:1'
      ],
      {
        signal: options.signal,
        onStderr: (text) => {
          if (durationKnown) return
          stderrSoFar += text
          const duration = parseInputDuration(stderrSoFar)
          if (duration !== null || /Stream mapping:|Output #0/.test(stderrSoFar)) {
            durationKnown = true
            options.onDuration?.(duration)
          }
        },
        onStdout: (chunk, stream) => {
          // Keep samples whole. A 16-bit sample split across two chunks would
          // shift every later sample by a byte and turn speech into noise.
          const joined = carry ? Buffer.concat([carry, chunk]) : chunk
          const usable = joined.length - (joined.length % 2)
          carry = usable < joined.length ? Buffer.from(joined.subarray(usable)) : null
          const pcm = joined.subarray(0, usable)

          stream.pause()
          pending = pending
            .then(() => deliver(pcm))
            .then(
              () => {
                stream.resume()
              },
              (err: unknown) => {
                sinkError = err
                stream.destroy()
              }
            )
        }
      }
    )
  } catch (err) {
    await pending.catch(() => undefined)
    throw sinkError ?? err
  }
  await pending
  if (sinkError !== null) throw sinkError
}

/** Compress a WAV to Opus in an Ogg container, tuned for speech. */
export async function encodeOpus(inputWav: string, output: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  await runFfmpeg(
    ['-nostats', '-y', '-i', inputWav, '-vn', '-map_metadata', '-1', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip', '-f', 'ogg', output],
    options
  )
}

/** Decode any audio file to the app's own WAV format. */
export async function decodeToWav(input: string, output: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  await runFfmpeg(
    ['-nostats', '-y', '-i', input, '-vn', '-map_metadata', '-1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-bitexact', '-f', 'wav', output],
    options
  )
}

/**
 * Decode a whole file and report how long it actually plays for. Proves the
 * file decodes from start to end, which a header alone cannot.
 */
export async function measureDecodedDuration(input: string, options: { signal?: AbortSignal } = {}): Promise<number | null> {
  const { stderr } = await runFfmpeg(['-i', input, '-vn', '-f', 'null', '-'], options)
  return parseLastTime(stderr)
}
