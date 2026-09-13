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

  libraryRescan: 'library:rescan',

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
  evtLibraryChanged: 'library:changed',
  evtRequestToggleRecord: 'ui:toggle-record',
  evtNavigate: 'ui:navigate'
} as const

/** Custom protocol used to stream lecture audio into the renderer. */
export const AUDIO_PROTOCOL = 'lecture-audio'
