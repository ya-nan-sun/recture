/**
 * The four ways to set Recture up, as the README lays them out: whether the
 * saved transcript is made on this computer or at Deepgram, and whether a live
 * draft streams while recording.
 */

import type { AppSettings, BatchProviderId, LiveProviderId } from './types'

export type SetupChoiceId = 'free-private' | 'free-live' | 'fast' | 'everything'

export interface SetupChoice {
  id: SetupChoiceId
  label: string
  liveProvider: LiveProviderId
  batchProvider: BatchProviderId
  /** Where the audio goes, plainly. */
  privacy: string
  cost: string
  needsPython: boolean
  needsDeepgramKey: boolean
}

export const SETUP_CHOICES: SetupChoice[] = [
  {
    id: 'free-private',
    label: 'Free and private',
    liveProvider: 'none',
    batchProvider: 'whisper-local',
    privacy: 'Nothing leaves your computer. Each transcript takes a while after the lecture.',
    cost: 'Free',
    needsPython: true,
    needsDeepgramKey: false
  },
  {
    id: 'free-live',
    label: 'Free, with live text',
    liveProvider: 'deepgram-live',
    batchProvider: 'whisper-local',
    privacy: 'Audio streams to Deepgram while you record, for text on screen. The saved transcript is made on your computer.',
    cost: 'About $0.29 per lecture hour',
    needsPython: true,
    needsDeepgramKey: true
  },
  {
    id: 'fast',
    label: 'Fast',
    liveProvider: 'none',
    batchProvider: 'deepgram-batch',
    privacy: 'The recording is uploaded to Deepgram after you stop. Transcripts are ready in minutes.',
    cost: 'About $0.26 per lecture hour',
    needsPython: false,
    needsDeepgramKey: true
  },
  {
    id: 'everything',
    label: 'Everything',
    liveProvider: 'deepgram-live',
    batchProvider: 'deepgram-batch',
    privacy: 'Audio streams to Deepgram while you record, and the recording is uploaded after you stop.',
    cost: 'About $0.55 per lecture hour',
    needsPython: false,
    needsDeepgramKey: true
  }
]

/** Which of the four setups the current settings amount to. */
export function matchSetup(settings: Pick<AppSettings, 'liveProvider' | 'batchProvider'>): SetupChoiceId | null {
  return (
    SETUP_CHOICES.find((c) => c.liveProvider === settings.liveProvider && c.batchProvider === settings.batchProvider)?.id ??
    null
  )
}

/** First launch: setup has not been done or put off, and there is nothing in the library yet. */
export function shouldShowSetup(settings: Pick<AppSettings, 'setupComplete'>, classCount: number): boolean {
  return !settings.setupComplete && classCount === 0
}

export type SetupRequirement = 'python' | 'deepgram-key'

export interface SetupStatus {
  ready: boolean
  /** Still finding out whether on-device transcription works. */
  checking: boolean
  missing: SetupRequirement[]
}

export function setupStatus(
  choice: SetupChoice,
  facts: { hasDeepgramKey: boolean; localAvailable: boolean | null }
): SetupStatus {
  const missing: SetupRequirement[] = []
  if (choice.needsPython && facts.localAvailable === false) missing.push('python')
  if (choice.needsDeepgramKey && !facts.hasDeepgramKey) missing.push('deepgram-key')
  const checking = choice.needsPython && facts.localAvailable === null
  return { ready: missing.length === 0 && !checking, checking, missing }
}
