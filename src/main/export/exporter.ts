/**
 * Turning lectures into files: one lecture in any format, a whole class as one
 * file, or a class as a folder of files. Every format is rendered from the
 * transcript on disk plus the lecture's bookmarks.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { ExportExtras, ExportOptions, LectureRecord, TranscriptFile } from '@shared/types'
import {
  EXPORT_FORMATS,
  lecturesToCsv,
  lecturesToExportJson,
  lecturesToText,
  toJsonText,
  transcriptToCsv,
  transcriptToExportJson,
  transcriptToSrt,
  transcriptToText,
  transcriptToVtt,
  type ExportFormat
} from '@shared/exportFormats'
import { lectureFolderName, sanitizeSegment, uniqueName } from '@shared/naming'
import { lecturesToMarkdown, transcriptToMarkdown } from './markdown'
import { lecturesToPdf, transcriptToPdf } from './pdf'
import { lecturesToDocx } from './docx'
import { loadTranscriptFile } from '../transcriptStore'
import { readBookmarks } from '../bookmarks'

export interface ExportItem {
  lecture: Pick<LectureRecord, 'title' | 'recordedAt'>
  transcript: TranscriptFile
  extras: ExportExtras
}

/** A lecture's transcript and bookmarks, or null if it has no transcript yet. */
export async function loadExportItem(lecture: Pick<LectureRecord, 'title' | 'recordedAt' | 'dirPath'>): Promise<ExportItem | null> {
  const loaded = await loadTranscriptFile(lecture.dirPath).catch(() => null)
  if (!loaded) return null
  return {
    lecture: { title: lecture.title, recordedAt: lecture.recordedAt },
    transcript: loaded.transcript,
    extras: { bookmarks: await readBookmarks(lecture.dirPath).catch(() => []) }
  }
}

/** Oldest first: the order a class was taught in. */
export function sortChronologically<T extends { lecture: { recordedAt: string } }>(items: T[]): T[] {
  return [...items].sort((a, b) => Date.parse(a.lecture.recordedAt) - Date.parse(b.lecture.recordedAt))
}

export async function renderLecture(format: ExportFormat, item: ExportItem, options: ExportOptions): Promise<string | Uint8Array> {
  const { transcript, extras } = item
  switch (format) {
    case 'markdown':
      return transcriptToMarkdown(transcript, options, extras)
    case 'pdf':
      return transcriptToPdf(transcript, options, extras)
    case 'docx':
      return lecturesToDocx([{ transcript, extras }], options, { title: transcript.lectureTitle })
    case 'txt':
      return transcriptToText(transcript, options, extras)
    case 'srt':
      return transcriptToSrt(transcript, options)
    case 'vtt':
      return transcriptToVtt(transcript, options)
    case 'csv':
      return transcriptToCsv(transcript, options)
    case 'json':
      return toJsonText(transcriptToExportJson(transcript, options, extras))
  }
}

/** A whole class in one file. Subtitles belong to a single recording, so they are refused. */
export async function renderClass(
  format: ExportFormat,
  className: string,
  items: ExportItem[],
  options: ExportOptions
): Promise<string | Uint8Array> {
  if (!EXPORT_FORMATS[format].combinable) {
    throw new Error(`${EXPORT_FORMATS[format].label} can only be exported as one file per lecture.`)
  }
  if (items.length === 0) throw new Error('None of these lectures has a transcript yet.')
  const documents = sortChronologically(items).map(({ transcript, extras }) => ({ transcript, extras }))
  switch (format) {
    case 'markdown':
      return lecturesToMarkdown(className, documents, options)
    case 'pdf':
      return lecturesToPdf(documents, options, { title: className, subject: `Lecture transcripts, ${className}` })
    case 'docx':
      return lecturesToDocx(documents, options, { title: className })
    case 'txt':
      return lecturesToText(className, documents, options)
    case 'csv':
      return lecturesToCsv(documents, options)
    case 'json':
      return toJsonText(lecturesToExportJson(className, documents, options))
    default:
      throw new Error(`${EXPORT_FORMATS[format].label} can only be exported as one file per lecture.`)
  }
}

/** Files in a lecture folder that belong to the app and must never be overwritten by an export. */
const RESERVED_NAMES = new Set(['transcript.json', 'transcript.live.json', 'lecture.json', 'bookmarks.json'])

/** Where an export goes inside the lecture's own folder. */
export function lectureFolderExportPath(lectureDir: string, format: ExportFormat): string {
  const name = format === 'json' ? 'transcript.export.json' : `transcript.${EXPORT_FORMATS[format].extension}`
  if (RESERVED_NAMES.has(name)) throw new Error('Refusing to overwrite a file the app depends on.')
  return path.join(lectureDir, name)
}

/** A safe file name for a lecture or class exported elsewhere. */
export function exportFileName(name: string, format: ExportFormat): string {
  return `${sanitizeSegment(name, 'Transcript')}.${EXPORT_FORMATS[format].extension}`
}

/** Write through a temporary file, so a failed export never leaves half a file behind. */
export async function writeExportFile(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporary, data)
    await fs.rename(temporary, filePath)
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * One file per lecture in `folder`, named by date and title. An earlier export
 * of the same lecture is replaced; two lectures that share a name both keep
 * their own file.
 */
export async function exportLecturesToFolder(
  folder: string,
  items: ExportItem[],
  format: ExportFormat,
  options: ExportOptions
): Promise<string[]> {
  const extension = EXPORT_FORMATS[format].extension
  const used = new Set<string>()
  const written: string[] = []
  for (const item of sortChronologically(items)) {
    const base = lectureFolderName(new Date(item.lecture.recordedAt), item.lecture.title)
    const name = uniqueName(base, (candidate) => used.has(candidate.toLowerCase()))
    used.add(name.toLowerCase())
    const target = path.join(folder, `${name}.${extension}`)
    await writeExportFile(target, await renderLecture(format, item, options))
    written.push(target)
  }
  return written
}
