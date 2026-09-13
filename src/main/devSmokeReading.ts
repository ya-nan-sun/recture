/**
 * Integration checks for reading a lecture: search that finds the moment
 * something was said, hand edits and speaker names saved safely, bookmarks in
 * exports, and upgrading an older search index. Real SQLite and real files.
 */

import * as path from 'node:path'
import { DEFAULT_EXPORT_OPTIONS, SEARCH_MARK_END, SEARCH_MARK_START } from '@shared/types'
import { editSegmentText, revertSegmentEdit, setSpeakerName } from '@shared/transcript'
import { openDatabase, type Db } from './db/database'
import {
  createClass,
  createLecture,
  indexLectureTranscript,
  reindexSearch,
  renameClass,
  renameLecture
} from './library'
import { RecordingController } from './recordingController'
import { addBookmark, readBookmarks } from './bookmarks'
import { loadTranscriptFile, updateTranscript } from './transcriptStore'
import { transcriptToMarkdown } from './export/markdown'
import { transcriptToPdf } from './export/pdf'
import { testSettings, type SmokeContext } from './devSmokePipeline'

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function runReadingChecks(ctx: SmokeContext & { db: Db; userDataDir: string }): Promise<void> {
  const { repos, root, check, frame, stubTranscriber, db } = ctx
  const settings = testSettings(root)
  const klass = await createClass(repos, root, { name: 'CHEM 1100 Bonds' })
  // The stub transcript says "eigen value", so this glossary term raises a suggestion.
  repos.glossary.add(klass.id, 'eigenvalue', null)

  const controller = new RecordingController({
    repos,
    getSettings: () => settings,
    getApiKey: () => null,
    getTranscriber: () => stubTranscriber(),
    broadcast: () => undefined
  })

  const lecture = await createLecture(repos, klass, { title: 'Week 2' })
  await controller.start(klass, lecture)
  for (let i = 0; i < 12; i++) controller.writeAudio(toArrayBuffer(frame(100)))
  await controller.stop()
  await controller.queue.idle()

  const hitFor = (query: string) => repos.lectures.search(query).find((h) => h.lectureId === lecture.id)
  const lectureDir = (): string => repos.lectures.get(lecture.id)!.dirPath

  // --- search by moment ------------------------------------------------------
  const matrix = hitFor('matrix')
  check(
    'search finds the moment a word was said',
    matrix?.matches.length === 1 && matrix.matches[0]!.startSec === 0 && Boolean(matrix.matches[0]!.segmentId),
    JSON.stringify(matrix)
  )
  check(
    'search marks matches with characters no transcript can contain',
    Boolean(matrix?.matches[0]?.snippet.includes(`${SEARCH_MARK_START}matrix${SEARCH_MARK_END}`)),
    JSON.stringify(matrix?.matches[0]?.snippet)
  )

  // --- renames keep lectures searchable -----------------------------------------
  await renameClass(repos, root, repos.classes.get(klass.id)!, 'CHEM 1100 Chemical Bonds')
  check('renaming a class keeps its lectures searchable', hitFor('matrix')?.matches.length === 1)
  await renameLecture(repos, repos.classes.get(klass.id)!, repos.lectures.get(lecture.id)!, 'Covalent bonds')
  check(
    'renaming a lecture keeps it searchable, and findable by its new title',
    hitFor('matrix')?.matches.length === 1 && Boolean(hitFor('Covalent'))
  )

  // --- hand edits ---------------------------------------------------------------
  const before = (await loadTranscriptFile(lectureDir()))!.transcript
  const segmentId = before.segments[0]!.id
  const suggestionsBefore = before.suggestions.filter((s) => s.segmentId === segmentId).length

  const edited = await updateTranscript(lectureDir(), (t) =>
    editSegmentText(t, segmentId, 'the eigenvalue of the covariance matrix')
  )
  indexLectureTranscript(repos, lecture.id, repos.classes.get(klass.id)!.name, repos.lectures.get(lecture.id)!.title, edited)
  const onDisk = (await loadTranscriptFile(lectureDir()))!.transcript
  check(
    'a hand edit is saved, keeping the original wording',
    onDisk.segments[0]!.text === 'the eigenvalue of the covariance matrix' &&
      onDisk.segments[0]!.edit?.originalText === before.segments[0]!.text
  )
  check(
    'an edited passage stops offering glossary suggestions that no longer fit',
    suggestionsBefore > 0 && onDisk.suggestions.every((s) => s.segmentId !== segmentId),
    `${suggestionsBefore} before`
  )
  check('search finds words corrected by hand', hitFor('covariance')?.matches.length === 1)

  const reverted = await updateTranscript(lectureDir(), (t) => revertSegmentEdit(t, segmentId))
  check(
    'restoring a passage brings back its words and its suggestions',
    reverted.segments[0]!.text === before.segments[0]!.text &&
      !reverted.segments[0]!.edit &&
      reverted.suggestions.filter((s) => s.segmentId === segmentId).length === suggestionsBefore
  )

  // --- two changes at once --------------------------------------------------------
  await Promise.all([
    updateTranscript(lectureDir(), (t) => setSpeakerName(t, 'Speaker 1', 'Prof. Okafor')),
    updateTranscript(lectureDir(), (t) => editSegmentText(t, segmentId, 'bonds form when electrons are shared'))
  ])
  const both = (await loadTranscriptFile(lectureDir()))!.transcript
  check(
    'changes saved at the same moment are both kept',
    both.speakerNames?.['Speaker 1'] === 'Prof. Okafor' && both.segments[0]!.text === 'bonds form when electrons are shared',
    JSON.stringify({ names: both.speakerNames, text: both.segments[0]!.text })
  )

  // --- exports ------------------------------------------------------------------------
  await addBookmark(lectureDir(), 0.5, 'definition of a covalent bond')
  const bookmarks = await readBookmarks(lectureDir())
  const markdown = transcriptToMarkdown(both, DEFAULT_EXPORT_OPTIONS, { bookmarks })
  check(
    'Markdown export lists the bookmarks',
    markdown.includes('## Bookmarks') && markdown.includes('`0:00` definition of a covalent bond')
  )
  check(
    'exports use speaker names and hand edits',
    markdown.includes('**Prof. Okafor:**') && markdown.includes('electrons are shared')
  )
  const pdf = await transcriptToPdf(both, DEFAULT_EXPORT_OPTIONS, { bookmarks })
  check('PDF export with bookmarks and speaker names is well-formed', Buffer.from(pdf.subarray(0, 5)).toString('ascii') === '%PDF-')

  // --- an index from before search by moment ------------------------------------------
  db.exec('DELETE FROM segment_search')
  check('an index without passages is recognised as out of date', repos.lectures.segmentIndexIsStale())
  await reindexSearch(repos)
  check(
    'rebuilding the index restores search by moment, from what is on disk',
    !repos.lectures.segmentIndexIsStale() && hitFor('electrons')?.matches.length === 1
  )

  const legacyDir = path.join(ctx.userDataDir, 'legacy-index')
  const legacy = openDatabase(legacyDir)
  legacy.exec('DROP TABLE segment_search')
  legacy.pragma('user_version = 1')
  legacy.close()
  const upgraded = openDatabase(legacyDir)
  const hasTable = Boolean(upgraded.prepare("SELECT name FROM sqlite_master WHERE name = 'segment_search'").get())
  const version = upgraded.pragma('user_version', { simple: true })
  upgraded.close()
  check('a search index from an older version is upgraded in place', hasTable && version === 2, `${hasTable}, v${version}`)

  await controller.shutdown()
}
