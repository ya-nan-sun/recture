/**
 * PDF export via pdf-lib.
 *
 * Built from the same `toParagraphs` output as the Markdown and clipboard
 * exports, so the three can never disagree about what the transcript says.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import type { ExportOptions, TranscriptFile } from '@shared/types'
import { formatClock } from '@shared/naming'
import { materializeTranscript, toParagraphs } from '@shared/transcript'

const PAGE = { width: 595.28, height: 841.89 } // A4 portrait
const MARGIN = 56
const BODY_SIZE = 10.5
const LINE_HEIGHT = 15.5

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and throw on anything outside
 * that range, which a transcript full of “smart quotes” and mathematical
 * symbols will certainly contain. Map the common cases and drop the rest
 * rather than failing the export.
 */
function toWinAnsi(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[•·]/g, '-')
    .replace(/→/g, '->')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue
      const candidate = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      // A single token wider than the column (a long URL, a formula) has to be
      // broken by character or it would overflow the page silently.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = ''
        for (const char of word) {
          if (font.widthOfTextAtSize(chunk + char, size) > maxWidth) {
            lines.push(chunk)
            chunk = char
          } else {
            chunk += char
          }
        }
        line = chunk
      } else {
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

export async function transcriptToPdf(transcript: TranscriptFile, options: ExportOptions): Promise<Uint8Array> {
  const source = options.applyAcceptedSuggestions ? materializeTranscript(transcript) : transcript

  const doc = await PDFDocument.create()
  doc.setTitle(`${transcript.lectureTitle} — ${transcript.className}`)
  doc.setSubject(`Lecture transcript, ${transcript.className}`)
  doc.setCreator('Recture')

  const body = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const mono = await doc.embedFont(StandardFonts.Courier)

  const contentWidth = PAGE.width - MARGIN * 2
  let page: PDFPage = doc.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - MARGIN

  const newPage = (): void => {
    page = doc.addPage([PAGE.width, PAGE.height])
    y = PAGE.height - MARGIN
  }
  const need = (space: number): void => {
    if (y - space < MARGIN) newPage()
  }

  const draw = (text: string, font: PDFFont, size: number, color = rgb(0.1, 0.1, 0.12)): void => {
    for (const line of wrap(toWinAnsi(text), font, size, contentWidth)) {
      need(LINE_HEIGHT)
      page.drawText(line, { x: MARGIN, y: y - size, size, font, color })
      y -= LINE_HEIGHT
    }
  }

  // --- header --------------------------------------------------------------
  draw(transcript.lectureTitle, bold, 18)
  y -= 4
  const recorded = new Date(transcript.recordedAt)
  const dateLabel = Number.isNaN(recorded.getTime())
    ? transcript.recordedAt
    : recorded.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
  draw(`${transcript.className} · ${dateLabel}`, body, 11, rgb(0.35, 0.35, 0.4))
  draw(
    `Duration ${formatClock(transcript.durationSec)} · Transcribed by ${transcript.source.provider} (${transcript.source.model})`,
    body,
    9,
    rgb(0.45, 0.45, 0.5)
  )

  if (transcript.source.pass === 'live-draft') {
    y -= 4
    draw('LIVE DRAFT — this is not a final transcript and may contain errors.', bold, 9.5, rgb(0.7, 0.35, 0))
  }
  if (transcript.excludedAudioSegments.length > 0) {
    y -= 4
    draw(
      `Warning: ${transcript.excludedAudioSegments.length} audio segment(s) failed integrity checks and were ` +
        'excluded. Some of the lecture may be missing.',
      bold,
      9.5,
      rgb(0.75, 0.2, 0.2)
    )
  }

  y -= 10
  need(12)
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE.width - MARGIN, y },
    thickness: 0.75,
    color: rgb(0.8, 0.8, 0.85)
  })
  y -= 18

  // --- body ----------------------------------------------------------------
  for (const p of toParagraphs(source.segments, options.paragraphSeconds)) {
    need(LINE_HEIGHT * 2)
    if (options.includeTimestamps) {
      page.drawText(toWinAnsi(`[${formatClock(p.start)}]`), {
        x: MARGIN,
        y: y - BODY_SIZE,
        size: 8.5,
        font: mono,
        color: rgb(0.5, 0.5, 0.58)
      })
      y -= LINE_HEIGHT
    }
    if (p.speaker) draw(`${p.speaker}:`, bold, BODY_SIZE)
    draw(p.text, body, BODY_SIZE)
    y -= 8
  }

  // --- page numbers --------------------------------------------------------
  const pages = doc.getPages()
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`
    p.drawText(label, {
      x: PAGE.width - MARGIN - body.widthOfTextAtSize(label, 8),
      y: MARGIN / 2,
      size: 8,
      font: body,
      color: rgb(0.55, 0.55, 0.6)
    })
  })

  return doc.save()
}
