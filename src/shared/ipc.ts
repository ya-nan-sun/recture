/** Channel names shared by main and preload, kept in one place. */

export const IPC = {
  // settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsProviders: 'settings:providers',
  settingsSetApiKey: 'settings:set-api-key',
  settingsHasApiKey: 'settings:has-api-key',
  settingsDiskEncryption: 'settings:disk-encryption',
  settingsChooseRoot: 'settings:choose-root',
  settingsSetHotkey: 'settings:set-hotkey',
  settingsHotkeyStatus: 'settings:hotkey-status',

  libraryRescan: 'library:rescan',

  // system
  systemDiskSpace: 'system:disk-space',
  /** main -> renderer: the computer woke from sleep during a recording. */
  evtPowerNotice: 'system:power-notice',

  // classes
  classesList: 'classes:list',
  classCreate: 'classes:create',
  classUpdate: 'classes:update',
  classRename: 'classes:rename',
  classDelete: 'classes:delete',

  // lectures
  lecturesByClass: 'lectures:by-class',
  lecturesAll: 'lectures:all',
  lectureGet: 'lectures:get',
  lectureCreate: 'lectures:create',
  lectureRename: 'lectures:rename',
  lectureMove: 'lectures:move',
  lectureDelete: 'lectures:delete',
  lectureSearch: 'lectures:search',
  lectureReveal: 'lectures:reveal',
  lectureVerify: 'lectures:verify',

  // glossary
  glossaryList: 'glossary:list',
  glossaryAdd: 'glossary:add',
  glossaryUpdate: 'glossary:update',
  glossaryRemove: 'glossary:remove',
  glossaryImport: 'glossary:import',

  // recording
  recordingStart: 'recording:start',
  recordingStop: 'recording:stop',
  recordingState: 'recording:get-state',
  recordingAudio: 'recording:audio-chunk',
  recordingPause: 'recording:pause',
  recordingResume: 'recording:resume',
  recordingBookmark: 'recording:bookmark',

  // bookmarks
  bookmarksList: 'bookmarks:list',
  bookmarksUpdate: 'bookmarks:update',
  bookmarksRemove: 'bookmarks:remove',

  // transcription queue
  transcriptionQueue: 'transcription:get-queue',
  transcriptionCancel: 'transcription:cancel',

  // transcript
  transcriptGet: 'transcript:get',
  transcriptRetry: 'transcript:retry',
  transcriptSetSuggestion: 'transcript:set-suggestion',
  transcriptAudioUrl: 'transcript:audio-url',

  // export
  exportMarkdown: 'export:markdown',
  exportPdf: 'export:pdf',
  exportClipboard: 'export:clipboard',

  // events (main -> renderer)
  evtRecordingState: 'recording:state',
  evtRecordingError: 'recording:error',
  evtLiveTranscript: 'recording:live-transcript',
  evtTranscriptionProgress: 'transcription:progress',
  evtTranscriptionQueue: 'transcription:queue',
  evtBookmarkAdded: 'recording:bookmarked',
  evtLibraryChanged: 'library:changed',
  evtRequestToggleRecord: 'ui:toggle-record',
  evtNavigate: 'ui:navigate'
} as const

/** Custom protocol used to stream lecture audio into the renderer. */
export const AUDIO_PROTOCOL = 'lecture-audio'
