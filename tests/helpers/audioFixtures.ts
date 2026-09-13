import * as path from 'node:path'
import { runFfmpeg } from '@main/audio/ffmpeg'

/** A 440 Hz tone of `seconds`, encoded however the test needs (e.g. `-ac 2` for stereo). */
export async function makeTone(dir: string, fileName: string, seconds: number, extraArgs: string[] = []): Promise<string> {
  const output = path.join(dir, fileName)
  await runFfmpeg([
    '-nostats',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=44100:duration=${seconds}`,
    ...extraArgs,
    output
  ])
  return output
}
