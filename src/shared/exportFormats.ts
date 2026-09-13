/**
 * The export formats, and the text-based ones themselves: plain text,
 * subtitles, a spreadsheet and JSON.
 *
 * Every format is built from the same readable transcript the lecture view
 * shows — corrections, speaker names and the clean reading mode included — so
 * no two formats can disagree about what was said. Pure, so the exact output
 * of each is tested directly.
 */

import type { Bookmark, ExportExtras, ExportOptions, TranscriptFile } from './types'
import { formatClock, localDateStamp } from './naming'
import { readableParagraphs, readableSegments, speakersIn, type ReadingOptions } from './transcript'

export type ExportFormat = 'markdown' | 'pdf' | 'docx' | 'txt' | 'srt' | 'vtt' | 'csv' | 'json'

/** A whole class as one file, or a file for each lecture. */
export type ClassExportLayout = 'single' | 'per-lecture'

export interface ExportFormatInfo {
  label: string
  extension: string
  /** What the format is good for. */
  hint: string
  /** Whether a whole class can go into one file of this format. */
  combinable: boolean
}

export const EXPORT_FORMATS: Record<ExportFormat, ExportFormatInfo> = {
  markdown: { label: 'Markdown', extension: 'md', hint: 'For notes apps such as Obsidian, Notion or OneNote.', combinable: true },
  pdf: { label: 'PDF', extension: 'pdf', hint: 'To print, annotate, or read on any device.', combinable: true },
  docx: { label: 'Word document', extension: 'docx', hint: 'To edit in Word, Google Docs or Pages.', combinable: true },
  txt: { label: 'Plain text', extension: 'txt', hint: 'Just the words, readable anywhere.', combinable: true },
  srt: {
    label: 'Subtitles (SRT)',
    extension: 'srt',
    hint: 'Captions timed to the recording, for video players and editors.',
    combinable: false
  },
  vtt: {
    label: 'Subtitles (WebVTT)',
    extension: 'vtt',
    hint: 'Captions timed to the recording, for web and course video players.',
    combinable: false
  },
  csv: {
    label: 'Spreadsheet (CSV)',
    extension: 'csv',
    hint: 'One row per passage, with times and speakers, for Excel or Google Sheets.',
    combinable: true
  },
  json: { label: 'JSON', extension: 'json', hint: 'Structured data for scripts and other tools.', combinable: true }
}

export const EXPORT_FORMAT_ORDER: ExportFormat[] = ['markdown', 'pdf', 'docx', 'txt', 'srt', 'vtt', 'csv', 'json']

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, value)
}

/** One lecture's transcript and what is exported alongside it. */
export interface ExportDocument {
  transcript: TranscriptFile
  extras?: ExportExtras
}

export interface ClassExportResult {
  /** The file, or the folder of files, that was written. */
  path: string
  exported: number
  /** Lectures left out because they have no transcript yet. */
  skipped: number
}

export function formatLectureDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function dateStamp(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : localDateStamp(date)
}

/** The bookmarks an export includes, in lecture order. */
export function exportedBookmarks(options: Pick<ExportOptions, 'includeBookmarks'>, extras: ExportExtras = {}): Bookmark[] {
  return options.includeBookmarks ? [...(extras.bookmarks ?? [])].sort((a, b) => a.atSec - b.atSec) : []
}

// --- plain text --------------------------------------------------------------------

export function transcriptToText(transcript: TranscriptFile, options: ExportOptions, extras: ExportExtras = {}): string {
  const lines: string[] = [transcript.lectureTitle]
  lines.push(
    [
      transcript.className,
      formatLectureDate(transcript.recordedAt),
      transcript.durationSec > 0 ? formatClock(transcript.durationSec) : null
    ]
      .filter(Boolean)
      .join(' · ')
  )
  lines.push(`Transcribed by ${transcript.source.provider} (${transcript.source.model})`)
  if (transcript.source.pass === 'live-draft') lines.push('LIVE DRAFT: not a final transcript, and less accurate.')
  if (transcript.excludedAudioSegments.length > 0) {
    lines.push(
      `Warning: ${transcript.excludedAudioSegments.length} audio segment(s) failed integrity checks and were excluded. Some of the lecture may be missing.`
    )
  }

  const bookmarks = exportedBookmarks(options, extras)
  if (bookmarks.length > 0) {
    lines.push('', 'Bookmarks')
    for (const bookmark of bookmarks) {
      lines.push(`  ${formatClock(bookmark.atSec)}  ${bookmark.note.trim() || 'Bookmarked moment'}`)
    }
  }

  lines.push('')
  for (const p of readableParagraphs(transcript, options)) {
    const prefix = [options.includeTimestamps ? `[${formatClock(p.start)}]` : null, p.speaker ? `${p.speaker}:` : null]
      .filter(Boolean)
      .join(' ')
    lines.push(prefix ? `${prefix} ${p.text}` : p.text, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function lecturesToText(className: string, documents: ExportDocument[], options: ExportOptions): string {
  const header = `${className}\n${'='.repeat(Math.max(3, className.length))}\n${documents.length} lecture${documents.length === 1 ? '' : 's'}\n`
  const rule = `\n${'-'.repeat(60)}\n\n`
  return `${header}\n${documents.map((d) => transcriptToText(d.transcript, options, d.extras)).join(rule)}`
}

// --- subtitles ---------------------------------------------------------------------

export interface Cue {
  start: number
  end: number
  speaker: string | null
  text: string
}

export interface CueLimits {
  /** Characters on screen at once: two lines. */
  maxChars: number
  /** Longest a caption stays up. */
  maxSeconds: number
  /** Characters per line. */
  lineChars: number
  /** Shortest a caption stays up, so it can be read. */
  minSeconds: number
}

export const CUE_LIMITS: CueLimits = { maxChars: 84, maxSeconds: 7, lineChars: 42, minSeconds: 0.5 }

/**
 * Split one passage into captions short enough to read, timing each by its
 * share of the passage's characters.
 */
export function splitIntoCues(
  text: string,
  start: number,
  end: number,
  limits: CueLimits = CUE_LIMITS
): { start: number; end: number; text: string }[] {
  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const span = Math.max(0, end - start)
  const totalChars = tokens.reduce((n, t) => n + t.length, 0) + tokens.length - 1
  const pieces = Math.max(1, Math.ceil(totalChars / limits.maxChars), Math.ceil(span / limits.maxSeconds))
  const target = Math.ceil(totalChars / pieces)

  const chunks: string[][] = []
  let current: string[] = []
  let length = 0
  for (const token of tokens) {
    const withToken = current.length > 0 ? length + 1 + token.length : token.length
    if (current.length > 0 && withToken > target) {
      chunks.push(current)
      current = [token]
      length = token.length
    } else {
      current.push(token)
      length = withToken
    }
  }
  if (current.length > 0) chunks.push(current)

  let consumed = 0
  return chunks.map((words, i) => {
    const last = i === chunks.length - 1
    const cueText = words.join(' ')
    const cueStart = start + (consumed / totalChars) * span
    consumed += cueText.length + (last ? 0 : 1)
    return { start: cueStart, end: last ? end : start + (consumed / totalChars) * span, text: cueText }
  })
}

/** Captions for the whole lecture, in order, never overlapping. */
export function buildCues(transcript: TranscriptFile, options: ReadingOptions, limits: CueLimits = CUE_LIMITS): Cue[] {
  const cues: Cue[] = []
  for (const segment of readableSegments(transcript, options)) {
    for (const part of splitIntoCues(segment.text, segment.start, segment.end, limits)) {
      cues.push({ ...part, speaker: segment.speaker })
    }
  }
  cues.sort((a, b) => a.start - b.start)
  let previousEnd = 0
  for (const cue of cues) {
    if (cue.start < previousEnd) cue.start = previousEnd
    if (cue.end < cue.start + limits.minSeconds) cue.end = cue.start + limits.minSeconds
    previousEnd = cue.end
  }
  return cues
}

/** Break a caption over two lines at the space nearest its middle. */
export function wrapCueText(text: string, lineChars = CUE_LIMITS.lineChars): string {
  if (text.length <= lineChars) return text
  const middle = text.length / 2
  let best = -1
  for (let at = text.indexOf(' '); at >= 0; at = text.indexOf(' ', at + 1)) {
    if (best < 0 || Math.abs(at - middle) < Math.abs(best - middle)) best = at
  }
  return best < 0 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`
}

function clockParts(seconds: number): { h: number; m: number; s: number; ms: number } {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  return {
    h: Math.floor(total / 3_600_000),
    m: Math.floor((total % 3_600_000) / 60_000),
    s: Math.floor((total % 60_000) / 1000),
    ms: total % 1000
  }
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

export function srtTimestamp(seconds: number): string {
  const c = clockParts(seconds)
  return `${pad(c.h)}:${pad(c.m)}:${pad(c.s)},${pad(c.ms, 3)}`
}

export function vttTimestamp(seconds: number): string {
  const c = clockParts(seconds)
  return `${pad(c.h)}:${pad(c.m)}:${pad(c.s)}.${pad(c.ms, 3)}`
}

/** SubRip captions. The speaker is named whenever the speaker changes. */
export function transcriptToSrt(transcript: TranscriptFile, options: ReadingOptions): string {
  let previousSpeaker: string | null = null
  return buildCues(transcript, options)
    .map((cue, i) => {
      const named = cue.speaker !== null && cue.speaker !== previousSpeaker
      previousSpeaker = cue.speaker
      // "-->" inside a caption would be read as a timing line.
      const text = wrapCueText(`${named ? `${cue.speaker}: ` : ''}${cue.text}`.replace(/-->/g, '->'))
      return `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${text}\n`
    })
    .join('\n')
}

const vttEscape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** WebVTT captions, with speakers as voice tags. */
export function transcriptToVtt(transcript: TranscriptFile, options: ReadingOptions): string {
  const cues = buildCues(transcript, options).map((cue) => {
    const voice = cue.speaker ? `<v ${vttEscape(cue.speaker)}>` : ''
    return `${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${voice}${wrapCueText(vttEscape(cue.text))}\n`
  })
  return ['WEBVTT\n', ...cues].join('\n')
}

// --- spreadsheet ----------------------------------------------------------------------

/** Text a spreadsheet would run as a formula if a cell started with it. */
const FORMULA_START = /^(?:[=+@\t\r]|-(?=[^\s\d.]))/

export function csvCell(value: string | number): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV as spreadsheets expect it: a byte-order mark so accents survive Excel, and CRLF line ends. */
function toCsv(rows: (string | number)[][]): string {
  return `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
}

const hundredths = (seconds: number): number => Math.round(seconds * 100) / 100

export function transcriptToCsv(transcript: TranscriptFile, options: ReadingOptions): string {
  const rows: (string | number)[][] = [['Start', 'End', 'Start (seconds)', 'Speaker', 'Text', 'Edited']]
  for (const s of readableSegments(transcript, options)) {
    rows.push([formatClock(s.start), formatClock(s.end), hundredths(s.start), s.speaker ?? '', s.text, s.edited ? 'yes' : ''])
  }
  return toCsv(rows)
}

export function lecturesToCsv(documents: ExportDocument[], options: ReadingOptions): string {
  const rows: (string | number)[][] = [['Lecture', 'Date', 'Start', 'End', 'Start (seconds)', 'Speaker', 'Text', 'Edited']]
  for (const { transcript } of documents) {
    for (const s of readableSegments(transcript, options)) {
      rows.push([
        transcript.lectureTitle,
        dateStamp(transcript.recordedAt),
        formatClock(s.start),
        formatClock(s.end),
        hundredths(s.start),
        s.speaker ?? '',
        s.text,
        s.edited ? 'yes' : ''
      ])
    }
  }
  return toCsv(rows)
}

// --- JSON -----------------------------------------------------------------------------

export interface LectureExportJson {
  format: 'recture.lecture'
  version: 1
  lecture: { id: string; title: string; className: string; recordedAt: string; durationSec: number }
  source: TranscriptFile['source']
  speakers: { label: string; name: string | null }[]
  bookmarks: { atSec: number; note: string }[]
  segments: { start: number; end: number; speaker: string | null; text: string; edited: boolean }[]
}

export interface ClassExportJson {
  format: 'recture.class'
  version: 1
  className: string
  lectures: LectureExportJson[]
}

const thousandths = (seconds: number): number => Math.round(seconds * 1000) / 1000

export function transcriptToExportJson(
  transcript: TranscriptFile,
  options: ExportOptions,
  extras: ExportExtras = {}
): LectureExportJson {
  return {
    format: 'recture.lecture',
    version: 1,
    lecture: {
      id: transcript.lectureId,
      title: transcript.lectureTitle,
      className: transcript.className,
      recordedAt: transcript.recordedAt,
      durationSec: thousandths(transcript.durationSec)
    },
    source: { ...transcript.source },
    speakers: speakersIn(transcript).map((label) => ({ label, name: transcript.speakerNames?.[label] ?? null })),
    bookmarks: exportedBookmarks(options, extras).map((b) => ({ atSec: thousandths(b.atSec), note: b.note })),
    segments: readableSegments(transcript, options).map((s) => ({
      start: thousandths(s.start),
      end: thousandths(s.end),
      speaker: s.speaker,
      text: s.text,
      edited: s.edited
    }))
  }
}

export function lecturesToExportJson(className: string, documents: ExportDocument[], options: ExportOptions): ClassExportJson {
  return {
    format: 'recture.class',
    version: 1,
    className,
    lectures: documents.map((d) => transcriptToExportJson(d.transcript, options, d.extras))
  }
}

export function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
