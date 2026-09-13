/**
 * Microphone capture in the renderer.
 *
 * Produces exactly what the rest of the pipeline expects: 16 kHz mono 16-bit
 * PCM, in small frames, handed straight to the main process. Frames are never
 * accumulated here — the renderer is the least durable place in the app, so
 * audio spends as little time in it as possible.
 */

import { AUDIO_FORMAT } from '@shared/types'

/** Emitted ~every 128 ms; small enough for a responsive live transcript. */
const FRAME_SAMPLES = 2048

/**
 * The worklet is defined inline and loaded from a blob URL so it survives
 * bundling and packaging without a separate asset path to get wrong.
 */
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.frameSamples = options.processorOptions.frameSamples
    this.buffer = new Float32Array(this.frameSamples)
    this.offset = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    // No input yet (or the device dropped out): keep the node alive.
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.offset++] = channel[i]
      if (this.offset === this.frameSamples) {
        const pcm = new Int16Array(this.frameSamples)
        let peak = 0
        let sumSquares = 0
        for (let k = 0; k < this.frameSamples; k++) {
          let sample = this.buffer[k]
          if (sample > 1) sample = 1
          else if (sample < -1) sample = -1
          const magnitude = sample < 0 ? -sample : sample
          if (magnitude > peak) peak = magnitude
          sumSquares += sample * sample
          // Asymmetric range: -32768..32767
          pcm[k] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
        }
        this.port.postMessage(
          { pcm: pcm.buffer, peak: peak, rms: Math.sqrt(sumSquares / this.frameSamples) },
          [pcm.buffer]
        )
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor)
`

export interface MicLevel {
  /** 0..1 peak amplitude of the most recent frame. */
  peak: number
  /** 0..1 RMS amplitude of the most recent frame. */
  rms: number
}

export interface CaptureOptions {
  deviceId?: string
  /** Called for every frame. Omit to run as a level-meter-only mic check. */
  onFrame?: (pcm: ArrayBuffer) => void
  onLevel?: (level: MicLevel) => void
  onError?: (error: Error) => void
}

export interface MicCapture {
  stop: () => Promise<void>
  /** Constraints the browser actually applied, for the mic-check UI. */
  settings: MediaTrackSettings
  deviceLabel: string
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}

/**
 * Open the microphone and start emitting PCM frames.
 *
 * The three WebRTC constraints below are what make a laptop's built-in mic
 * usable in a noisy lecture hall: suppression for HVAC and crowd noise,
 * echo cancellation for room reverb, and AGC so a quiet professor at the far
 * end of the room stays audible.
 */
export async function startCapture(options: CaptureOptions = {}): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
      channelCount: { ideal: AUDIO_FORMAT.channels },
      sampleRate: { ideal: AUDIO_FORMAT.sampleRate },
      noiseSuppression: { ideal: true },
      echoCancellation: { ideal: true },
      autoGainControl: { ideal: true }
    },
    video: false
  })

  // Asking the context for 16 kHz makes the browser resample for us, so no
  // hand-rolled resampling can drift or alias.
  const context = new AudioContext({ sampleRate: AUDIO_FORMAT.sampleRate })
  const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))

  try {
    await context.audioWorklet.addModule(blobUrl)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }

  const source = context.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(context, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: AUDIO_FORMAT.channels,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: { frameSamples: FRAME_SAMPLES }
  })

  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number; rms: number }>) => {
    const { pcm, peak, rms } = event.data
    options.onLevel?.({ peak, rms })
    options.onFrame?.(pcm)
  }

  source.connect(node)

  // A track ending mid-lecture (device unplugged, driver reset) must be
  // surfaced, not silently swallowed into an hour of silence.
  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () =>
      options.onError?.(new Error(`Microphone "${track.label || 'input'}" stopped unexpectedly.`))
    )
  }

  const track = stream.getAudioTracks()[0]

  return {
    settings: track?.getSettings() ?? {},
    deviceLabel: track?.label || 'Default microphone',
    stop: async () => {
      node.port.onmessage = null
      try {
        source.disconnect()
        node.disconnect()
      } catch {
        // already torn down
      }
      for (const t of stream.getTracks()) t.stop()
      await context.close().catch(() => undefined)
    }
  }
}

/** Map a 0..1 amplitude onto a meter-friendly 0..1 scale in dBFS. */
export function levelToMeter(amplitude: number): number {
  if (amplitude <= 0) return 0
  const db = 20 * Math.log10(amplitude)
  const floor = -60
  if (db <= floor) return 0
  return Math.min(1, (db - floor) / -floor)
}
