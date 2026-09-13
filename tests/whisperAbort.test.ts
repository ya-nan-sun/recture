import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WhisperLocalTranscriber } from '@main/transcription/whisperLocal'
import { TranscriptionAbortedError } from '@main/transcription/types'

function hasPython(): boolean {
  for (const command of ['python', 'python3', 'py']) {
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      // try the next one
    }
  }
  return false
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasPython())('stopping local transcription', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-whisper-abort-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const transcriberFor = (scriptPath: string): WhisperLocalTranscriber =>
    new WhisperLocalTranscriber({
      scriptPath: () => scriptPath,
      pythonPath: () => '',
      model: () => 'tiny.en',
      computeType: () => 'int8'
    })

  it('kills the Python process and reports a stop, not a failure', async () => {
    // Stands in for a long transcription: records its pid, then just waits.
    const script = path.join(dir, 'slow.py')
    await fs.writeFile(
      script,
      [
        'import json, os, sys, time',
        'request = json.load(open(sys.argv[1]))',
        "open(request['audioPath'] + '.pid', 'w').write(str(os.getpid()))",
        'time.sleep(60)'
      ].join('\n')
    )
    const audioPath = path.join(dir, 'lecture.wav')
    await fs.writeFile(audioPath, Buffer.alloc(100))

    const controller = new AbortController()
    const pending = transcriberFor(script).transcribe({
      audioPath,
      language: 'en',
      keyterms: [],
      signal: controller.signal
    })
    // Attach a handler now so the eventual rejection is never unhandled.
    const outcome = pending.then(
      () => null,
      (err: unknown) => err
    )

    let pid = 0
    for (let i = 0; i < 200 && !pid; i++) {
      await sleep(50)
      pid = Number(await fs.readFile(`${audioPath}.pid`, 'utf8').catch(() => '0'))
    }
    expect(pid).toBeGreaterThan(0)
    expect(isAlive(pid)).toBe(true)

    controller.abort('shutdown')
    expect(await outcome).toBeInstanceOf(TranscriptionAbortedError)

    // Regression: quitting used to leave Python transcribing in the background.
    let alive = true
    for (let i = 0; i < 100 && alive; i++) {
      alive = isAlive(pid)
      if (alive) await sleep(50)
    }
    expect(alive).toBe(false)
  }, 30_000)

  it('never starts Python for a job that was already stopped', async () => {
    const controller = new AbortController()
    controller.abort('shutdown')
    await expect(
      transcriberFor(path.join(dir, 'never-run.py')).transcribe({
        audioPath: path.join(dir, 'missing.wav'),
        language: 'en',
        keyterms: [],
        signal: controller.signal
      })
    ).rejects.toBeInstanceOf(TranscriptionAbortedError)
  })
})
