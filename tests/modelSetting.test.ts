import { describe, expect, it } from 'vitest'
import { DeepgramBatchTranscriber } from '@main/transcription/deepgramBatch'

describe('model settings are read at request time', () => {
  it('picks up a model change without reconstructing the transcriber', async () => {
    // Regression: `model` used to be captured once at construction, so changing
    // it in Settings had no effect until the app was restarted.
    let model = 'nova-3'
    const transcriber = new DeepgramBatchTranscriber({ getApiKey: () => 'key', model: () => model })

    expect(transcriber.buildUrl([], 'en')).toContain('model=nova-3')
    expect((await transcriber.checkAvailability()).detail).toContain('nova-3')

    model = 'nova-2'
    expect(transcriber.buildUrl([], 'en')).toContain('model=nova-2')
    expect((await transcriber.checkAvailability()).detail).toContain('nova-2')
  })

  it('sends keyterm for nova-3 and keywords for older models', () => {
    let model = 'nova-3'
    const transcriber = new DeepgramBatchTranscriber({ getApiKey: () => 'key', model: () => model })

    expect(transcriber.buildUrl(['eigenvalue'], 'en')).toContain('keyterm=eigenvalue')
    model = 'nova-2'
    const url = transcriber.buildUrl(['eigenvalue'], 'en')
    expect(url).toContain('keywords=eigenvalue')
    expect(url).not.toContain('keyterm=')
  })
})
