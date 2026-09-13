/**
 * Integration checks for exporting: every format saved from real lectures on
 * disk, a class as one file and as a folder of files, and the lecture's own
 * files left untouched.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { EXPORT_FORMAT_ORDER } from '@shared/exportFormats'
import { createClass, createLecture } from './library'
import { RecordingController } from './recordingController'
import { addBookmark } from './bookmarks'
import { sha256File } from './audio/wav'
import { lecturePaths } from './storage/paths'
import {
  exportLecturesToFolder,
  lectureFolderExportPath,
  loadExportItem,
  renderClass,
  renderLecture,
  writeExportFile,
  type ExportItem
} from './export/exporter'
import { testSettings, type SmokeContext } from './devSmokePipeline'

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function runExportChecks(ctx: SmokeContext & { userDataDir: string }): Promise<void> {
  const { repos, root, check, frame, stubTranscriber } = ctx
  const settings = testSettings(root)
  const klass = await createClass(repos, root, { name: 'HIST 2200 Empires' })
  const controller = new RecordingController({
    repos,
    getSettings: () => settings,
    getApiKey: () => null,
    getTranscriber: () => stubTranscriber(),
    broadcast: () => undefined
  })

  const record = async (title: string) => {
    const lecture = await createLecture(repos, klass, { title })
    await controller.start(klass, lecture)
    for (let i = 0; i < 12; i++) controller.writeAudio(toArrayBuffer(frame(100)))
    await controller.stop()
    await controller.queue.idle()
    return repos.lectures.get(lecture.id)!
  }

  const rome = await record('Rome')
  const byzantium = await record('Byzantium')
  const untranscribed = await createLecture(repos, klass, { title: 'Not transcribed yet' })
  repos.lectures.setStatus(untranscribed.id, 'needs_transcription', null)
  await addBookmark(rome.dirPath, 0.4, 'founding myth')

  // --- one lecture, every format ------------------------------------------------
  const transcriptBefore = await sha256File(lecturePaths(rome.dirPath).transcript)
  const romeItem = (await loadExportItem(rome))!
  const saved: Record<string, number> = {}
  for (const format of EXPORT_FORMAT_ORDER) {
    const target = lectureFolderExportPath(rome.dirPath, format)
    await writeExportFile(target, await renderLecture(format, romeItem, DEFAULT_EXPORT_OPTIONS))
    saved[path.basename(target)] = (await fs.stat(target)).size
  }
  check(
    'every export format saves into the lecture folder',
    Object.keys(saved).length === EXPORT_FORMAT_ORDER.length && Object.values(saved).every((size) => size > 0),
    JSON.stringify(saved)
  )
  check(
    'exporting never overwrites the transcript it is made from',
    (await sha256File(lecturePaths(rome.dirPath).transcript)) === transcriptBefore && 'transcript.export.json' in saved
  )

  const docx = unzipSync(new Uint8Array(await fs.readFile(lectureFolderExportPath(rome.dirPath, 'docx'))))
  check(
    'the Word export is a complete package containing the lecture',
    Boolean(docx['word/document.xml'] && docx['[Content_Types].xml'] && docx['word/styles.xml']) &&
      strFromU8(docx['word/document.xml']!).includes('Rome') &&
      strFromU8(docx['word/document.xml']!).includes('founding myth')
  )
  const srt = await fs.readFile(lectureFolderExportPath(rome.dirPath, 'srt'), 'utf8')
  const vtt = await fs.readFile(lectureFolderExportPath(rome.dirPath, 'vtt'), 'utf8')
  check(
    'subtitle exports are timed captions',
    srt.startsWith('1\n00:00:00,000 --> ') && vtt.startsWith('WEBVTT\n\n00:00:00.000 --> '),
    JSON.stringify({ srt: srt.slice(0, 40), vtt: vtt.slice(0, 40) })
  )
  const csv = await fs.readFile(lectureFolderExportPath(rome.dirPath, 'csv'), 'utf8')
  check('the spreadsheet export opens with its header row', csv.startsWith('﻿Start,End,Start (seconds),Speaker,Text,Edited\r\n'))
  const json = JSON.parse(await fs.readFile(lectureFolderExportPath(rome.dirPath, 'json'), 'utf8')) as {
    format: string
    bookmarks: unknown[]
  }
  check('the JSON export is structured and includes bookmarks', json.format === 'recture.lecture' && json.bookmarks.length === 1)

  // --- a whole class ----------------------------------------------------------------
  const lectures = repos.lectures.listByClass(klass.id)
  const items = (await Promise.all(lectures.map((lecture) => loadExportItem(lecture)))).filter(
    (item): item is ExportItem => item !== null
  )
  check('only lectures with a transcript are exported', lectures.length === 3 && items.length === 2)

  const markdown = (await renderClass('markdown', klass.name, items, DEFAULT_EXPORT_OPTIONS)) as string
  check(
    'a class exports as one document, oldest lecture first',
    markdown.startsWith('# HIST 2200 Empires') && markdown.indexOf('## Rome') < markdown.indexOf('## Byzantium'),
    markdown.slice(0, 120)
  )
  const pdf = await PDFDocument.load((await renderClass('pdf', klass.name, items, DEFAULT_EXPORT_OPTIONS)) as Uint8Array)
  check('a class PDF starts each lecture on its own page', pdf.getPageCount() >= 2, String(pdf.getPageCount()))

  const folder = path.join(ctx.userDataDir, 'class-export')
  const written = await exportLecturesToFolder(folder, items, 'vtt', DEFAULT_EXPORT_OPTIONS)
  const names = written.map((file) => path.basename(file))
  check(
    'a class exports as a folder with a file per lecture, named by date and title',
    names.length === 2 &&
      /^\d{4}-\d{2}-\d{2} - Rome\.vtt$/.test(names[0]!) &&
      /^\d{4}-\d{2}-\d{2} - Byzantium\.vtt$/.test(names[1]!) &&
      (await fs.readFile(written[0]!, 'utf8')).startsWith('WEBVTT'),
    names.join(', ')
  )
  const again = await exportLecturesToFolder(folder, [items[0]!, items[0]!], 'txt', DEFAULT_EXPORT_OPTIONS)
  check(
    'lectures that share a name each keep their own file',
    new Set(again).size === 2 && (await Promise.all(again.map((file) => fs.stat(file)))).every((s) => s.size > 0),
    again.map((file) => path.basename(file)).join(', ')
  )

  let refused = ''
  try {
    await renderClass('srt', klass.name, items, DEFAULT_EXPORT_OPTIONS)
  } catch (err) {
    refused = (err as Error).message
  }
  check('subtitles for a class are never merged into one file', /one file per lecture/.test(refused), refused)

  await controller.shutdown()
}
