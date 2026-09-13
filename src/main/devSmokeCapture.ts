/**
 * Integration checks for capture safety: keeping the computer awake while
 * recording, saving the open segment before sleep, reading disk space, and the
 * settings that remember the microphone and a lost API key.
 *
 * Run from devSmoke inside Electron, against the real power blocker, real
 * SQLite and real audio files.
 */

import { powerSaveBlocker, safeStorage } from 'electron'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { IPC } from '@shared/ipc'
import type { PowerNotice, RecordingState } from '@shared/types'
import { createClass, createLecture } from './library'
import { RecordingController } from './recordingController'
import { PowerGuard } from './powerGuard'
import { getDiskSpace } from './diskSpace'
import { SettingsStore } from './storage/settings'
import { testSettings, type SmokeContext } from './devSmokePipeline'

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function runCaptureSafetyChecks(ctx: SmokeContext & { userDataDir: string }): Promise<void> {
  const { repos, root, check, frame, stubTranscriber } = ctx
  const settings = testSettings(root)
  const klass = await createClass(repos, root, { name: 'PHYS 2020 Waves' })

  // --- sleep prevention and suspend, wired exactly as index.ts wires them ---
  const notices: PowerNotice[] = []
  let guard: PowerGuard | null = null
  const controller = new RecordingController({
    repos,
    getSettings: () => settings,
    getApiKey: () => null,
    getTranscriber: () => stubTranscriber(),
    broadcast: (channel, payload) => {
      if (channel === IPC.evtRecordingState) guard?.setRecording(Boolean((payload as RecordingState).active))
    }
  })
  guard = new PowerGuard(
    {
      start: () => powerSaveBlocker.start('prevent-app-suspension'),
      stop: (id) => powerSaveBlocker.stop(id),
      isStarted: (id) => powerSaveBlocker.isStarted(id)
    },
    {
      isRecording: () => controller.isRecording,
      isPaused: () => controller.getState().paused,
      pause: () => controller.pause(),
      notify: (notice) => notices.push(notice)
    }
  )

  check('the computer may sleep while nothing is recording', !guard.isBlocking)

  const lecture = await createLecture(repos, klass, { title: 'Sleep test' })
  await controller.start(klass, lecture)
  check('the computer is kept awake while recording', guard.isBlocking)

  // Half a second into a one-second segment: this audio is only in the open file.
  for (let i = 0; i < 5; i++) controller.writeAudio(toArrayBuffer(frame(100)))
  const segmentsBefore = repos.segments.listByLecture(lecture.id).length

  await guard.onSuspend()
  const asleep = controller.getState()
  const saved = repos.segments.listByLecture(lecture.id)
  check('going to sleep pauses the recording', asleep.paused)
  check(
    'going to sleep saves the open segment first',
    saved.length === segmentsBefore + 1,
    `${segmentsBefore} -> ${saved.length}`
  )
  check(
    'the segment saved before sleep is checksummed',
    saved.length > 0 && saved.every((s) => /^[0-9a-f]{64}$/.test(s.sha256) && s.durationSec > 0)
  )
  check('the computer stays awake while the recording is paused', guard.isBlocking)

  guard.onResume()
  check(
    'waking tells the student the recording was paused',
    notices.length === 1 && notices[0]!.pausedForSleep,
    JSON.stringify(notices)
  )
  check('waking does not resume recording by itself', controller.getState().paused)

  controller.resume()
  for (let i = 0; i < 5; i++) controller.writeAudio(toArrayBuffer(frame(100)))
  await controller.stop()
  check('the computer may sleep again once recording stops', !guard.isBlocking)
  await controller.queue.idle()
  const total = repos.segments.listByLecture(lecture.id).reduce((sum, s) => sum + s.durationSec, 0)
  check('audio either side of the sleep is kept', Math.abs(total - 1.0) < 0.01, total.toFixed(3))
  guard.dispose()

  // --- disk space ------------------------------------------------------------
  const space = await getDiskSpace(root)
  check(
    'free space on the library drive can be read',
    space !== null && space.freeBytes > 0 && space.totalBytes >= space.freeBytes,
    JSON.stringify(space)
  )
  const notCreated = await getDiskSpace(path.join(root, 'not', 'created', 'yet'))
  check('free space can be read before the library folder exists', (notCreated?.freeBytes ?? 0) > 0)

  // --- settings ----------------------------------------------------------------
  const settingsDir = path.join(ctx.userDataDir, 'capture-settings')
  await fs.mkdir(settingsDir, { recursive: true })
  // A settings file from a build that predates these fields.
  await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({ rootDir: root, liveProvider: 'none' }))
  const store = new SettingsStore(settingsDir)
  const loaded = store.get()
  check(
    'settings from an older build gain the new fields',
    loaded.micDeviceId === '' && loaded.apiKeyReentryNotice === false && loaded.liveProvider === 'none'
  )

  store.update({ micDeviceId: 'usb-1' })
  check('the chosen microphone is remembered across launches', new SettingsStore(settingsDir).get().micDeviceId === 'usb-1')

  store.update({ apiKeyReentryNotice: true })
  check('a key lost in the rename is remembered across launches', new SettingsStore(settingsDir).get().apiKeyReentryNotice)
  if (safeStorage.isEncryptionAvailable()) {
    store.setApiKey('deepgram', '')
    check('removing a key keeps the re-entry notice', new SettingsStore(settingsDir).get().apiKeyReentryNotice)
    store.setApiKey('deepgram', 'dg-smoke-key')
    check('saving a key clears the re-entry notice', !new SettingsStore(settingsDir).get().apiKeyReentryNotice)
  } else {
    check('OS secret storage is available for the API key check', false, 'safeStorage unavailable')
  }
}
