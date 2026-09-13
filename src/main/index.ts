/**
 * Electron main process: the window, the global record hotkey, the audio
 * protocol, and startup crash recovery.
 */

import { app, BrowserWindow, globalShortcut, protocol, net, shell } from 'electron'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AUDIO_PROTOCOL, IPC } from '@shared/ipc'
import { openDatabase } from './db/database'
import { createRepos } from './db/repos'
import { SettingsStore } from './storage/settings'
import { migrateLegacyUserData } from './storage/migrateLegacy'
import { HotkeyManager } from './hotkey'
import { ensureDir, isInside } from './storage/paths'
import { classesRoot } from './storage/paths'
import { RecordingController, broadcaster } from './recordingController'
import { registerClipboardSection, registerIpc } from './ipc'
import { recoverAllInterrupted } from './library'
import { LibraryWatcher, describeRescan, rescanLibrary, reportIsEmpty } from './rescan'
import { DeepgramBatchTranscriber } from './transcription/deepgramBatch'
import { WhisperLocalTranscriber } from './transcription/whisperLocal'
import type { BatchTranscriber } from './transcription/types'

// Streams lecture audio to the renderer without disabling web security or
// exposing the whole filesystem through file://.
protocol.registerSchemesAsPrivileged([
  { scheme: AUDIO_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

let mainWindow: BrowserWindow | null = null
/** Set once the app is ready; used by the quit handler to flush audio. */
let controllerRef: RecordingController | null = null
let watcherRef: LibraryWatcher | null = null
let hotkeyRef: HotkeyManager | null = null

const isDev = !app.isPackaged

function rendererUrl(): { url?: string; file?: string } {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (isDev && devServer) return { url: devServer }
  return { file: path.join(__dirname, '../renderer/index.html') }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Recture',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // External links open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const target = rendererUrl()
  if (target.url) void win.loadURL(target.url)
  else void win.loadFile(target.file!)

  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

function allWindows(): BrowserWindow[] {
  return mainWindow ? [mainWindow] : []
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')

  // The app used to be called LectureRec, which means userData used to live
  // somewhere else. Bring settings, the saved API key and the index across
  // before anything reads them.
  const migration = migrateLegacyUserData(userData)
  if (migration.migrated) {
    console.log(`Migrated ${migration.files.length} file(s) from ${migration.from}`)
  }

  const settings = new SettingsStore(userData)
  const db = openDatabase(userData)
  const repos = createRepos(db)

  await ensureDir(classesRoot(settings.get().rootDir))

  // Serve lecture audio, but only from inside the library root.
  protocol.handle(AUDIO_PROTOCOL, (request) => {
    try {
      const encoded = new URL(request.url).pathname.replace(/^\/+/, '')
      const filePath = decodeURIComponent(encoded)
      if (!isInside(settings.get().rootDir, filePath)) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })

  const broadcast = broadcaster(allWindows)

  const whisper = new WhisperLocalTranscriber({
    scriptPath: () =>
      isDev
        ? path.join(app.getAppPath(), 'resources', 'python', 'transcribe.py')
        : path.join(process.resourcesPath, 'python', 'transcribe.py'),
    pythonPath: () => process.env.RECTURE_PYTHON ?? '',
    model: () => settings.get().whisperModel,
    computeType: () => settings.get().whisperComputeType
  })
  const deepgramBatch = new DeepgramBatchTranscriber({
    getApiKey: () => settings.getApiKey('deepgram'),
    model: () => settings.get().deepgramBatchModel
  })
  const transcribers: BatchTranscriber[] = [whisper, deepgramBatch]

  const controller = new RecordingController({
    repos,
    getSettings: () => settings.get(),
    getApiKey: (provider) => settings.getApiKey(provider),
    getTranscriber: () =>
      transcribers.find((t) => t.id === settings.get().batchProvider) ?? whisper,
    broadcast
  })

  controllerRef = controller
  registerIpc({
    repos,
    settings,
    controller,
    transcribers: () => transcribers,
    broadcast,
    hotkey: () => hotkeyRef
  })
  registerClipboardSection()

  mainWindow = createMainWindow()

  // A lecture left in `recording` state means the app died mid-lecture. Put
  // the audio back together before the student can touch anything.
  const recovered = await recoverAllInterrupted(repos).catch(() => [])
  if (recovered.length > 0) {
    mainWindow.webContents.once('did-finish-load', () => {
      broadcast(IPC.evtLibraryChanged, { recovered })
    })
  }

  // Reconcile with disk before the window is usable, so folders the student
  // renamed or deleted outside the app are reflected from the first frame.
  const runRescan = (): Promise<Awaited<ReturnType<typeof rescanLibrary>>> =>
    rescanLibrary(repos, settings.get().rootDir, { protectLectureId: controller.currentLectureId })

  const startupScan = await runRescan().catch(() => null)
  if (startupScan && !reportIsEmpty(startupScan)) {
    mainWindow.webContents.once('did-finish-load', () => {
      broadcast(IPC.evtLibraryChanged, { rescan: startupScan, message: describeRescan(startupScan) })
    })
  }

  // Then keep watching, so changes made in Explorer show up without a restart.
  watcherRef = new LibraryWatcher(
    () => settings.get().rootDir,
    (report) => broadcast(IPC.evtLibraryChanged, { rescan: report, message: describeRescan(report) }),
    runRescan
  )
  await watcherRef.start()

  // Record from anywhere: the student should not have to find the window when
  // the professor starts talking.
  hotkeyRef = new HotkeyManager(() => {
    broadcast(IPC.evtRequestToggleRecord, { source: 'hotkey' })
    if (!controller.isRecording && mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  const hotkeyStatus = hotkeyRef.apply(settings.get().recordHotkey)
  if (!hotkeyStatus.registered) {
    console.warn(`Record shortcut inactive: ${hotkeyStatus.detail}`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
  })
})

// Finish writing the current segment before the process goes away, so quitting
// mid-lecture costs nothing rather than orphaning the open segment.
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown || !controllerRef) return
  event.preventDefault()
  shuttingDown = true
  void Promise.resolve(watcherRef?.stop())
    .then(() => controllerRef?.shutdown())
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  hotkeyRef?.dispose()
  globalShortcut.unregisterAll()
})
