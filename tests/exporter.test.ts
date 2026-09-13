import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import type { TranscriptFile } from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { EXPORT_FORMAT_ORDER } from '@shared/exportFormats'
import {
  exportFileName,
  exportLecturesToFolder,
  lectureFolderExportPath,
  loadExportItem,
  renderClass,
  renderLecture,
  sortChronologically,
  writeExportFile,
  type ExportItem
} from '@main/export/exporter'
import { lecturePaths } from '@main/storage/paths'
import { bookmarksPath } from '@main/bookmarks'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-export-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function transcript(title: string, recordedAt: string): TranscriptFile {
  return {
    version: 1,
    lectureId: title,
    classId: 'c1',
    className: 'HIST 2200 Empires',
    lectureTitle: title,
    recordedAt,
    durationSec: 40,
    source: { pass: 'final', provider: 'whisper-local', model: 'medium.en', language: 'en' },
    createdAt: recordedAt,
    updatedAt: recordedAt,
    segments: [
      { id: `${title}-1`, start: 0, end: 4, speaker: 'Speaker 1', text: `Today we begin ${title}.`, words: [] },
      { id: `${title}-2`, start: 30, end: 36, speaker: 'Speaker 1', text: 'Any questions?', words: [] }
    ],
    suggestions: [],
    excludedAudioSegments: []
  }
}

function item(title: string, recordedAt: string): ExportItem {
  return { lecture: { title, recordedAt }, transcript: transcript(title, recordedAt), extras: { bookmarks: [] } }
}

const rome = item('Rome', '2026-09-10T12:00:00.000Z')
const byzantium = item('Byzantium', '2026-09-17T12:00:00.000Z')
const options = DEFAULT_EXPORT_OPTIONS
const asText = (data: string | Uint8Array): string => (typeof data === 'string' ? data : strFromU8(data))

describe('exporting one lecture', () => {
  it('renders every format', async () => {
    const checks: Record<string, (data: string | Uint8Array) => boolean> = {
      markdown: (d) => asText(d).startsWith('# Rome\n'),
      pdf: (d) => d instanceof Uint8Array && strFromU8(d.subarray(0, 5)) === '%PDF-',
      docx: (d) => d instanceof Uint8Array && strFromU8(unzipSync(d)['word/document.xml']!).includes('Today we begin Rome.'),
      txt: (d) => asText(d).startsWith('Rome\n'),
      srt: (d) => asText(d).startsWith('1\n00:00:00,000 --> 00:00:04,000\n'),
      vtt: (d) => asText(d).startsWith('WEBVTT\n\n'),
      csv: (d) => asText(d).startsWith('﻿Start,End'),
      json: (d) => (JSON.parse(asText(d)) as { format: string }).format === 'recture.lecture'
    }
    for (const format of EXPORT_FORMAT_ORDER) {
      const data = await renderLecture(format, rome, options)
      expect(checks[format]!(data), format).toBe(true)
    }
  })

  it('saves into the lecture folder without overwriting the files the app depends on', () => {
    const names = EXPORT_FORMAT_ORDER.map((format) => path.basename(lectureFolderExportPath(dir, format)))
    expect(names).toEqual([
      'transcript.md',
      'transcript.pdf',
      'transcript.docx',
      'transcript.txt',
      'transcript.srt',
      'transcript.vtt',
      'transcript.csv',
      'transcript.export.json'
    ])
    expect(names).not.toContain(path.basename(lecturePaths(dir).transcript))
  })

  it('names files it saves elsewhere safely', () => {
    expect(exportFileName('CS 4501: ML/AI', 'docx')).toBe('CS 4501 ML AI.docx')
    expect(exportFileName('', 'pdf')).toBe('Transcript.pdf')
  })

  it('writes through a temporary file, creating folders as needed', async () => {
    const target = path.join(dir, 'nested', 'deeper', 'Rome.txt')
    await writeExportFile(target, 'hello')
    expect(await fs.readFile(target, 'utf8')).toBe('hello')
    expect(await fs.readdir(path.dirname(target))).toEqual(['Rome.txt'])
  })

  it('loads a lecture with its bookmarks, or nothing without a transcript', async () => {
    const lectureDir = path.join(dir, 'Rome')
    await fs.mkdir(lectureDir, { recursive: true })
    const record = { title: 'Rome', recordedAt: rome.lecture.recordedAt, dirPath: lectureDir }
    expect(await loadExportItem(record)).toBeNull()

    await fs.writeFile(lecturePaths(lectureDir).transcript, JSON.stringify(rome.transcript))
    await fs.writeFile(
      bookmarksPath(lectureDir),
      JSON.stringify({ version: 1, bookmarks: [{ id: 'b', atSec: 2, note: 'founding', createdAt: '' }] })
    )
    const loaded = await loadExportItem(record)
    expect(loaded?.transcript.lectureTitle).toBe('Rome')
    expect(loaded?.extras.bookmarks?.map((b) => b.note)).toEqual(['founding'])
  })
})

describe('exporting a class', () => {
  it('puts the lectures in the order they were recorded', () => {
    expect(sortChronologically([byzantium, rome]).map((i) => i.lecture.title)).toEqual(['Rome', 'Byzantium'])
  })

  it('combines a class into one file, oldest lecture first, in every combinable format', async () => {
    const items = [byzantium, rome]
    const markdown = asText(await renderClass('markdown', 'HIST 2200 Empires', items, options))
    expect(markdown.startsWith('# HIST 2200 Empires\n')).toBe(true)
    expect(markdown.indexOf('## Rome')).toBeLessThan(markdown.indexOf('## Byzantium'))

    const text = asText(await renderClass('txt', 'HIST 2200 Empires', items, options))
    expect(text.indexOf('\nRome\n')).toBeLessThan(text.indexOf('\nByzantium\n'))

    const csvRows = asText(await renderClass('csv', 'HIST 2200 Empires', items, options)).split('\r\n')
    expect(csvRows[1]!.startsWith('Rome,')).toBe(true)
    expect(csvRows[3]!.startsWith('Byzantium,')).toBe(true)

    const json = JSON.parse(asText(await renderClass('json', 'HIST 2200 Empires', items, options))) as {
      lectures: { lecture: { title: string } }[]
    }
    expect(json.lectures.map((l) => l.lecture.title)).toEqual(['Rome', 'Byzantium'])

    const docx = strFromU8(unzipSync((await renderClass('docx', 'HIST 2200 Empires', items, options)) as Uint8Array)['word/document.xml']!)
    expect(docx.indexOf('Today we begin Rome.')).toBeLessThan(docx.indexOf('Today we begin Byzantium.'))

    const pdf = await PDFDocument.load((await renderClass('pdf', 'HIST 2200 Empires', items, options)) as Uint8Array)
    expect(pdf.getPageCount()).toBe(2)
    expect(pdf.getTitle()).toBe('HIST 2200 Empires')
  })

  it('refuses to merge subtitles, or to export a class with nothing in it', async () => {
    await expect(renderClass('srt', 'X', [rome], options)).rejects.toThrow(/one file per lecture/)
    await expect(renderClass('vtt', 'X', [rome], options)).rejects.toThrow(/one file per lecture/)
    await expect(renderClass('markdown', 'X', [], options)).rejects.toThrow(/transcript/)
  })

  it('writes a file per lecture, named by date and title, oldest first', async () => {
    const folder = path.join(dir, 'HIST 2200 Empires - VTT')
    const written = await exportLecturesToFolder(folder, [byzantium, rome], 'vtt', options)
    expect(written.map((file) => path.basename(file))).toEqual(['2026-09-10 - Rome.vtt', '2026-09-17 - Byzantium.vtt'])
    expect((await fs.readFile(written[0]!, 'utf8')).startsWith('WEBVTT')).toBe(true)
  })

  it('keeps lectures that share a name apart, and replaces an earlier export', async () => {
    const folder = path.join(dir, 'out')
    const twin = { ...rome, transcript: { ...rome.transcript, segments: [{ ...rome.transcript.segments[0]!, text: 'The other one.' }] } }
    const first = await exportLecturesToFolder(folder, [rome, twin], 'txt', options)
    expect(first.map((file) => path.basename(file))).toEqual(['2026-09-10 - Rome.txt', '2026-09-10 - Rome (2).txt'])
    expect(await fs.readFile(first[1]!, 'utf8')).toContain('The other one.')

    await exportLecturesToFolder(folder, [rome, twin], 'txt', options)
    expect((await fs.readdir(folder)).sort()).toEqual(['2026-09-10 - Rome (2).txt', '2026-09-10 - Rome.txt'])
  })
})
