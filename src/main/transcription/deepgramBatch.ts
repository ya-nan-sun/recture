/**
 * High-accuracy final pass via Deepgram's pre-recorded API.
 *
 * The assembled WAV is uploaded once. This is the path where lecture audio
 * leaves the device, which the UI states plainly wherever this provider is
 * selected.
 */

import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import type { ProviderAvailability } from '@shared/types'
import type { BatchTranscriber, TranscriptionRequest, TranscriptionResult } from './types'
import {
  PermanentTranscriptionError,
  TransientTranscriptionError,
  TranscriptionAbortedError,
  throwIfAborted
} from './types'
import { parseDeepgramResponse, type DeepgramResponse } from './deepgramParse'

export interface DeepgramBatchOptions {
  getApiKey: () => string | null
  /** A getter so a model change in Settings applies without a restart. */
  model: () => string
}

export class DeepgramBatchTranscriber implements BatchTranscriber {
  readonly id = 'deepgram-batch' as const
  readonly label = 'Deepgram (cloud batch)'
  readonly sendsAudioOffDevice = true

  constructor(private readonly options: DeepgramBatchOptions) {}

  async checkAvailability(): Promise<ProviderAvailability> {
    const key = this.options.getApiKey()
    return {
      id: this.id,
      available: Boolean(key),
      detail: key
        ? `Ready. Audio is uploaded to Deepgram (model ${this.options.model()}) for transcription.`
        : 'No Deepgram API key saved. Add one in Settings, or set DEEPGRAM_API_KEY.',
      sendsAudioOffDevice: true
    }
  }

  buildUrl(keyterms: string[], language: string): string {
    const model = this.options.model()
    const params = new URLSearchParams({
      model,
      language,
      smart_format: 'true',
      punctuate: 'true',
      paragraphs: 'true',
      utterances: 'true',
      diarize: 'true'
    })
    // nova-3 uses `keyterm`; earlier models use `keywords`. Sending the right
    // one is what makes course vocabulary actually land.
    const param = model.startsWith('nova-3') ? 'keyterm' : 'keywords'
    for (const term of keyterms) params.append(param, term)
    return `https://api.deepgram.com/v1/listen?${params.toString()}`
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    throwIfAborted(request.signal)
    const key = this.options.getApiKey()
    if (!key) throw new PermanentTranscriptionError('No Deepgram API key is configured.')

    const stat = await fs.stat(request.audioPath).catch(() => null)
    if (!stat || stat.size === 0) {
      throw new PermanentTranscriptionError(`Assembled audio is missing or empty: ${request.audioPath}`)
    }

    request.onProgress?.(null, `Uploading ${(stat.size / 1_048_576).toFixed(1)} MB to Deepgram…`)

    let response: Response
    try {
      response = await fetch(this.buildUrl(request.keyterms, request.language), {
        method: 'POST',
        headers: {
          Authorization: `Token ${key}`,
          'Content-Type': 'audio/wav'
        },
        // Streaming upload keeps a 3-hour lecture out of memory. `duplex` is
        // required by undici whenever the body is a stream.
        body: createReadStream(request.audioPath) as unknown as RequestInit['body'],
        duplex: 'half',
        signal: request.signal
      } as RequestInit & { duplex: 'half' })
    } catch (err) {
      // An aborted upload surfaces as a fetch error; it is a stop, not an outage.
      if (request.signal?.aborted) throw new TranscriptionAbortedError('Transcription was stopped.')
      // Network-level failure: worth retrying.
      throw new TransientTranscriptionError(`Could not reach Deepgram: ${(err as Error).message}`)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const detail = `${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 400)}` : ''}`
      if (response.status === 401 || response.status === 403) {
        throw new PermanentTranscriptionError(`Deepgram rejected the API key (${detail}).`)
      }
      if (response.status === 400) {
        throw new PermanentTranscriptionError(`Deepgram rejected the request (${detail}).`)
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after')) * 1000
        throw new TransientTranscriptionError(
          `Deepgram is unavailable (${detail}).`,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
        )
      }
      throw new PermanentTranscriptionError(`Deepgram request failed (${detail}).`)
    }

    request.onProgress?.(null, 'Deepgram is transcribing…')
    const payload = (await response.json()) as DeepgramResponse
    const { segments, durationSec } = parseDeepgramResponse(payload)

    if (segments.length === 0) {
      throw new PermanentTranscriptionError(
        'Deepgram returned an empty transcript. The audio may be silent — the recording has been kept.'
      )
    }

    return {
      provider: 'deepgram-batch',
      model: this.options.model(),
      language: request.language,
      durationSec,
      segments
    }
  }
}
