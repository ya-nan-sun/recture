import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  decodeToPcm,
  describeFfmpegFailure,
  encodeOpus,
  ffmpegPath,
  measureDecodedDuration,
  parseInputDuration,
  parseLastTime,
  unpackedPath
} from '@main/audio/ffmpeg'
import { makeTone } from './helpers/audioFixtures'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-ffmpeg-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('unpackedPath', () => {
  it('points a packaged app at the binary outside app.asar', () => {
    expect(unpackedPath('C:\\Apps\\Recture\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe')).toBe(
      'C:\\Apps\\Recture\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe'
    )
    expect(unpackedPath('/opt/Recture/resources/app.asar/node_modules/ffmpeg-static/ffmpeg')).toBe(
      '/opt/Recture/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg'
    )
  })

  it('leaves development and already-unpacked paths alone', () => {
    const dev = 'C:\\code\\recture\\node_modules\\ffmpeg-static\\ffmpeg.exe'
    expect(unpackedPath(dev)).toBe(dev)
    const unpacked = '/opt/Recture/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg'
    expect(unpackedPath(unpacked)).toBe(unpacked)
  })
})

describe('ffmpegPath', () => {
  const saved = process.env.RECTURE_FFMPEG
  afterEach(() => {
    if (saved === undefined) delete process.env.RECTURE_FFMPEG
    else process.env.RECTURE_FFMPEG = saved
  })

  it('finds the bundled binary', () => {
    delete process.env.RECTURE_FFMPEG
    expect(ffmpegPath()).toMatch(/ffmpeg(\.exe)?$/)
  })

  it('says clearly when ffmpeg is missing', () => {
    process.env.RECTURE_FFMPEG = path.join(os.tmpdir(), 'no-such-ffmpeg.exe')
    expect(() => ffmpegPath()).toThrow(/ffmpeg is missing/)
  })
})

describe('reading ffmpeg output', () => {
  const stderr = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'memo.m4a':",
    '  Duration: 01:02:03.45, start: 0.000000, bitrate: 128 kb/s',
    'size=     512kB time=00:00:04.10 bitrate=1024.0kbits/s speed= 80x',
    'size=    1024kB time=00:00:08.20 bitrate=1024.0kbits/s speed= 81x'
  ].join('\n')

  it('reads the length of the input', () => {
    expect(parseInputDuration(stderr)).toBeCloseTo(3723.45, 5)
    expect(parseInputDuration('Duration: N/A, bitrate: N/A')).toBeNull()
  })

  it('reads how far processing got', () => {
    expect(parseLastTime(stderr)).toBeCloseTo(8.2, 5)
    expect(parseLastTime('nothing here')).toBeNull()
  })

  it('explains common failures in plain language', () => {
    expect(describeFfmpegFailure('notes.mp3: Invalid data found when processing input', 1)).toMatch(/isn't audio or video/)
    expect(describeFfmpegFailure("Stream map '0:a:0' matches no streams.", 1)).toMatch(/doesn't have an audio track/)
    expect(describeFfmpegFailure('x.mp3: No such file or directory', 1)).toBe('The file could not be found.')
    expect(describeFfmpegFailure('something odd\nlast words\n', 3)).toBe('ffmpeg failed (exit 3): last words')
  })
})

describe('decodeToPcm', { timeout: 30_000 }, () => {
  it('delivers whole 16 kHz mono samples, however the output is chunked', async () => {
    const source = await makeTone(dir, 'tone.mp3', 3.3, ['-ac', '2'])
    const sizes: number[] = []
    let duration: number | null = null
    await decodeToPcm(
      source,
      async (pcm) => {
        sizes.push(pcm.length)
      },
      { onDuration: (seconds) => (duration = seconds) }
    )
    const total = sizes.reduce((n, s) => n + s, 0)
    expect(sizes.every((s) => s % 2 === 0)).toBe(true)
    expect(total / 32_000).toBeGreaterThan(3.25)
    expect(total / 32_000).toBeLessThan(3.45)
    expect(duration).not.toBeNull()
    expect(duration!).toBeCloseTo(3.3, 1)
  })

  it('stops, and reports the receiver’s error, when the receiver fails', async () => {
    const source = await makeTone(dir, 'tone.m4a', 20, ['-c:a', 'aac'])
    let calls = 0
    await expect(
      decodeToPcm(source, async () => {
        calls += 1
        throw new Error('disk full')
      })
    ).rejects.toThrow('disk full')
    expect(calls).toBe(1)
  })

  it('stops promptly when cancelled', async () => {
    const source = await makeTone(dir, 'long.mp3', 120)
    const abort = new AbortController()
    const started = Date.now()
    await expect(
      decodeToPcm(
        source,
        async () => {
          abort.abort()
        },
        { signal: abort.signal }
      )
    ).rejects.toMatchObject({ name: 'FfmpegAbortedError' })
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('lets go of the file it was reading as soon as it has been cancelled', async () => {
    // Regression: cancelling returned before ffmpeg had exited. On Windows the
    // file stayed locked for a moment, so deleting it straight away failed
    // with EBUSY.
    const source = await makeTone(dir, 'held.mp3', 120)
    const abort = new AbortController()
    await expect(
      decodeToPcm(
        source,
        async () => {
          abort.abort()
        },
        { signal: abort.signal }
      )
    ).rejects.toMatchObject({ name: 'FfmpegAbortedError' })
    await expect(fs.rm(source)).resolves.toBeUndefined()
  })
})

describe('Opus round trip', { timeout: 30_000 }, () => {
  it('compresses speech-sized audio and decodes back to the same length', async () => {
    const wav = await makeTone(dir, 'tone.wav', 4, ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'])
    const opus = path.join(dir, 'tone.opus')
    await encodeOpus(wav, opus)
    expect((await fs.stat(opus)).size).toBeLessThan((await fs.stat(wav)).size / 4)
    const decoded = await measureDecodedDuration(opus)
    expect(decoded).not.toBeNull()
    expect(Math.abs(decoded! - 4)).toBeLessThan(0.1)
  })
})
