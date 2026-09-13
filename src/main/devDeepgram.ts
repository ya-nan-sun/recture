/**
 * Dev-only live check of the two Deepgram code paths.
 *
 * Everything else in this app is verified offline, but the batch upload and the
 * streaming socket can only really be proven against the actual service. This
 * sends one short audio file — pass its path in DEEPGRAM_TEST_AUDIO — using the
 * API key already stored for the app.
 *
 * It transcribes a few seconds of audio twice, so the cost is a fraction of a
 * cent. Nothing from the user's library is read or uploaded.
 *
 *   npm run check:deepgram
 */

import { app } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { SettingsStore } from './storage/settings'
import { DeepgramBatchTranscriber } from './transcription/deepgramBatch'
import { DeepgramLiveSession } from './transcription/deepgramLive'
import { readWavInfo } from './audio/wav'
import { AUDIO_FORMAT } from '@shared/types'

// Running a bare script gives Electron its default identity ("Electron"), which
// points userData at the wrong folder and makes the stored API key invisible.
// Claim the real app name before anything resolves a path.
app.setName('Recture')

const lines: string[] = []
const log = (message: string): void => {
  lines.push(message)
}

async function batchCheck(settings: SettingsStore, audioPath: string): Promise<void> {
  log('--- batch (pre-recorded upload) ---')
  const transcriber = new DeepgramBatchTranscriber({
    getApiKey: () => settings.getApiKey('deepgram'),
    model: () => settings.get().deepgramBatchModel
  })

  const availability = await transcriber.checkAvailability()
  log(`availability : ${availability.available ? 'ready' : 'unavailable'} — ${availability.detail}`)
  if (!availability.available) return

  const started = Date.now()
  try {
    const result = await transcriber.transcribe({
      audioPath,
      language: settings.get().language,
      keyterms: ['eigenvalue', 'Nyquist', 'Dr. Chakrabarti', 'stochastic gradient descent'],
      onProgress: (_p, message) => log(`  progress   : ${message}`)
    })
    log(`elapsed      : ${((Date.now() - started) / 1000).toFixed(1)}s`)
    log(`provider     : ${result.provider} / ${result.model}`)
    log(`duration     : ${result.durationSec.toFixed(2)}s`)
    log(`segments     : ${result.segments.length}`)
    for (const segment of result.segments.slice(0, 3)) {
      log(`  [${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.speaker ?? 'no speaker'}: ${segment.text}`)
    }
    const words = result.segments.flatMap((s) => s.words)
    log(`words        : ${words.length}`)
    log(`confidences  : ${words.slice(0, 6).map((w) => w.confidence.toFixed(2)).join(', ')}`)
    log(
      `keyterms hit : ${['eigenvalue', 'Nyquist', 'Chakrabarti', 'stochastic'].filter((t) =>
        result.segments.some((s) => s.text.toLowerCase().includes(t.toLowerCase()))
      ).join(', ') || 'none'}`
    )
    log('RESULT       : BATCH OK')
  } catch (err) {
    log(`RESULT       : BATCH FAILED — ${(err as Error).name}: ${(err as Error).message}`)
  }
}

async function liveCheck(settings: SettingsStore, audioPath: string): Promise<void> {
  log('')
  log('--- live (streaming socket) ---')
  const apiKey = settings.getApiKey('deepgram')
  if (!apiKey) {
    log('RESULT       : skipped, no API key')
    return
  }

  const info = await readWavInfo(audioPath)
  const buffer = await fs.readFile(audioPath)
  const pcm = buffer.subarray(info.dataOffset, info.dataOffset + info.dataByteLength)

  const finals: string[] = []
  let interims = 0
  const statuses: string[] = []

  const session = new DeepgramLiveSession({
    apiKey,
    model: settings.get().deepgramLiveModel,
    language: settings.get().language,
    keyterms: ['eigenvalue', 'Nyquist'],
    onStatus: (status) => statuses.push(status.kind),
    onResult: (result) => {
      if (result.isFinal) finals.push(result.text)
      else interims += 1
    }
  })

  const started = Date.now()
  session.connect()

  // Wait for the socket, then feed the audio in realtime-sized frames the way
  // the recorder does.
  await new Promise((resolve) => setTimeout(resolve, 2500))
  log(`socket       : ${session.isOpen ? 'open' : 'not open'} (${statuses.join(' -> ')})`)

  const bytesPerFrame = (AUDIO_FORMAT.sampleRate * 2 * 128) / 1000 // ~128 ms
  for (let offset = 0; offset < pcm.length; offset += bytesPerFrame) {
    session.send(pcm.subarray(offset, Math.min(offset + bytesPerFrame, pcm.length)))
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  await session.close()
  await new Promise((resolve) => setTimeout(resolve, 1500))

  log(`elapsed      : ${((Date.now() - started) / 1000).toFixed(1)}s`)
  log(`interim msgs : ${interims}`)
  log(`final lines  : ${finals.length}`)
  for (const line of finals.slice(0, 4)) log(`  ${line}`)
  log(finals.length > 0 ? 'RESULT       : LIVE OK' : 'RESULT       : LIVE FAILED — no final transcript received')
}

app.whenReady().then(async () => {
  const audioPath = process.env.DEEPGRAM_TEST_AUDIO
  const settings = new SettingsStore(app.getPath('userData'))
  log(`userData     : ${app.getPath('userData')}`)

  try {
    if (!audioPath) throw new Error('Set DEEPGRAM_TEST_AUDIO to a 16 kHz mono WAV file.')
    await fs.stat(audioPath)
    log(`audio        : ${path.basename(audioPath)}`)
    log(`batch model  : ${settings.get().deepgramBatchModel}`)
    log(`live model   : ${settings.get().deepgramLiveModel}`)
    log('')

    await batchCheck(settings, audioPath)
    await liveCheck(settings, audioPath)
  } catch (err) {
    log(`CRASHED: ${(err as Error).message}`)
  }

  await fs.writeFile(process.env.DEEPGRAM_OUT ?? 'deepgram-check.txt', lines.join('\n'), 'utf8').catch(() => undefined)
  app.exit(0)
})
