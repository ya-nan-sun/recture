/**
 * Live draft transcript over Deepgram's streaming API.
 *
 * This exists purely so the student sees words appear while the professor is
 * talking. It is explicitly *not* the source of truth: the final pass replaces
 * it wholesale. Consequently every failure here is non-fatal — if the socket
 * never connects, or drops and never recovers, recording continues untouched
 * and the audio on disk is unaffected.
 */

import WebSocket from 'ws'
import type { LiveStatus } from '@shared/types'
import { AUDIO_FORMAT } from '@shared/types'
import { parseLiveMessage, type DeepgramLiveMessage, type LiveResult } from './deepgramParse'

export interface DeepgramLiveOptions {
  apiKey: string
  model: string
  language: string
  keyterms: string[]
  onResult: (result: LiveResult) => void
  onStatus: (status: LiveStatus) => void
}

const MAX_RECONNECT_ATTEMPTS = 5
/** Drop audio rather than grow without bound while the socket is down. */
const MAX_PENDING_BYTES = 4 * 1024 * 1024

export class DeepgramLiveSession {
  private socket: WebSocket | null = null
  private closedByUs = false
  private reconnectAttempt = 0
  private pending: Buffer[] = []
  private pendingBytes = 0
  private keepAlive: NodeJS.Timeout | null = null

  constructor(private readonly options: DeepgramLiveOptions) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  private buildUrl(): string {
    const params = new URLSearchParams({
      model: this.options.model,
      language: this.options.language,
      encoding: 'linear16',
      sample_rate: String(AUDIO_FORMAT.sampleRate),
      channels: String(AUDIO_FORMAT.channels),
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300'
    })
    const param = this.options.model.startsWith('nova-3') ? 'keyterm' : 'keywords'
    for (const term of this.options.keyterms) params.append(param, term)
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`
  }

  connect(): void {
    this.closedByUs = false
    this.options.onStatus(
      this.reconnectAttempt === 0 ? { kind: 'connecting' } : { kind: 'reconnecting', attempt: this.reconnectAttempt }
    )

    const socket = new WebSocket(this.buildUrl(), {
      headers: { Authorization: `Token ${this.options.apiKey}` }
    })
    this.socket = socket

    socket.on('open', () => {
      this.reconnectAttempt = 0
      this.options.onStatus({ kind: 'open' })
      this.flushPending()
      // Deepgram closes an idle socket; a silent lecture hall is still a
      // lecture, so keep it alive through the quiet stretches.
      this.keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' }))
      }, 8000)
    })

    socket.on('message', (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString()) as DeepgramLiveMessage
        if (message.error || message.type === 'Error') {
          this.options.onStatus({ kind: 'error', message: message.error ?? message.reason ?? 'Deepgram error' })
          return
        }
        const result = parseLiveMessage(message)
        if (result) this.options.onResult(result)
      } catch {
        // A malformed frame is not worth interrupting a lecture over.
      }
    })

    socket.on('error', (err: Error) => {
      this.options.onStatus({ kind: 'error', message: err.message })
    })

    socket.on('close', () => {
      this.clearKeepAlive()
      this.socket = null
      if (this.closedByUs) return
      if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        this.options.onStatus({
          kind: 'error',
          message: 'Live transcript disconnected. Recording continues; the final transcript is unaffected.'
        })
        return
      }
      this.reconnectAttempt += 1
      const delay = Math.min(15_000, 500 * 2 ** (this.reconnectAttempt - 1))
      setTimeout(() => {
        if (!this.closedByUs) this.connect()
      }, delay)
    })
  }

  /** Feed one PCM frame. Buffered (bounded) while the socket is down. */
  send(pcm: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(pcm)
      return
    }
    if (this.closedByUs) return
    this.pending.push(pcm)
    this.pendingBytes += pcm.length
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 0) {
      this.pendingBytes -= this.pending.shift()!.length
    }
  }

  private flushPending(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    for (const chunk of this.pending) this.socket.send(chunk)
    this.pending = []
    this.pendingBytes = 0
  }

  /** Ask Deepgram to flush, then close. */
  async close(): Promise<void> {
    this.closedByUs = true
    this.clearKeepAlive()
    const socket = this.socket
    this.pending = []
    this.pendingBytes = 0
    if (!socket) return

    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        // closing anyway
      }
      // Give Deepgram a moment to return the last finals, then hang up.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500)
        socket.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    socket.close()
    this.socket = null
    this.options.onStatus({ kind: 'disabled' })
  }

  private clearKeepAlive(): void {
    if (this.keepAlive) {
      clearInterval(this.keepAlive)
      this.keepAlive = null
    }
  }
}
