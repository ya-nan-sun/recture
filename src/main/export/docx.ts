/**
 * Word (.docx) export.
 *
 * A .docx is a zip of a few XML parts. The transcript needs only headings,
 * paragraphs and a little bold and grey, so the parts are written directly
 * rather than through a document library: the output is small, predictable,
 * and opens in Word, Google Docs, Pages and LibreOffice.
 */

import { strToU8, zipSync } from 'fflate'
import type { ExportExtras, ExportOptions, TranscriptFile } from '@shared/types'
import { formatClock } from '@shared/naming'
import { readableParagraphs } from '@shared/transcript'
import { exportedBookmarks, formatLectureDate } from '@shared/exportFormats'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** Escape text for XML, dropping characters XML cannot contain at all. */
export function xmlText(value: string): string {
  return value
    .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const GREY = '<w:color w:val="7A7A7A"/>'
const SMALL_GREY = '<w:color w:val="7A7A7A"/><w:sz w:val="18"/><w:szCs w:val="18"/>'
const MONO_GREY = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:color w:val="7A7A7A"/>'

function run(text: string, properties = ''): string {
  const props = properties ? `<w:rPr>${properties}</w:rPr>` : ''
  return `<w:r>${props}<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`
}

function paragraph(runs: string, style?: string, paragraphProperties = ''): string {
  const props =
    style || paragraphProperties
      ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${paragraphProperties}</w:pPr>`
      : ''
  return `<w:p>${props}${runs}</w:p>`
}

export interface DocxLecture {
  transcript: TranscriptFile
  extras?: ExportExtras
}

function lectureBody(transcript: TranscriptFile, extras: ExportExtras, options: ExportOptions, asSection: boolean): string[] {
  const out: string[] = []
  out.push(paragraph(run(transcript.lectureTitle), asSection ? 'Heading1' : 'Title', asSection ? '<w:pageBreakBefore/>' : ''))
  out.push(
    paragraph(
      run(
        [
          transcript.className,
          formatLectureDate(transcript.recordedAt),
          transcript.durationSec > 0 ? formatClock(transcript.durationSec) : null
        ]
          .filter(Boolean)
          .join(' · ')
      ),
      'Subtitle'
    )
  )
  out.push(paragraph(run(`Transcribed by ${transcript.source.provider} (${transcript.source.model})`, SMALL_GREY)))

  if (transcript.source.pass === 'live-draft') {
    out.push(paragraph(run('Live draft: not a final transcript, and less accurate.', '<w:b/><w:color w:val="B35C00"/>')))
  }
  if (transcript.excludedAudioSegments.length > 0) {
    out.push(
      paragraph(
        run(
          `${transcript.excludedAudioSegments.length} audio segment(s) failed integrity checks and were excluded. Some of the lecture may be missing.`,
          '<w:b/><w:color w:val="B42318"/>'
        )
      )
    )
  }

  const bookmarks = exportedBookmarks(options, extras)
  if (bookmarks.length > 0) {
    out.push(paragraph(run('Bookmarks'), 'Heading2'))
    for (const bookmark of bookmarks) {
      out.push(
        paragraph(run(`${formatClock(bookmark.atSec)}  `, MONO_GREY) + run(bookmark.note.trim() || 'Bookmarked moment'))
      )
    }
  }

  out.push(paragraph(run(asSection ? 'Transcript' : 'Transcript'), 'Heading2'))
  for (const p of readableParagraphs(transcript, options)) {
    const runs = [
      options.includeTimestamps ? run(`[${formatClock(p.start)}] `, GREY) : '',
      p.speaker ? run(`${p.speaker}: `, '<w:b/>') : '',
      run(p.text)
    ].join('')
    out.push(paragraph(runs))
  }
  return out
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${RELS}">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Recture</Application></Properties>`

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
</w:styles>`

function coreProperties(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlText(title)}</dc:title><dc:creator>Recture</dc:creator></cp:coreProperties>`
}

/** One lecture, or a whole class with each lecture on its own page. */
export function lecturesToDocx(lectures: DocxLecture[], options: ExportOptions, meta: { title: string }): Uint8Array {
  const asClass = lectures.length > 1
  const body: string[] = []
  if (asClass) {
    body.push(paragraph(run(meta.title), 'Title'))
    body.push(paragraph(run(`${lectures.length} lectures`), 'Subtitle'))
    for (const { transcript } of lectures) {
      body.push(paragraph(run(`${transcript.lectureTitle} · ${formatLectureDate(transcript.recordedAt)}`)))
    }
  }
  for (const { transcript, extras } of lectures) {
    body.push(...lectureBody(transcript, extras ?? {}, options, asClass))
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`

  return zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(ROOT_RELS),
      'docProps/core.xml': strToU8(coreProperties(meta.title)),
      'docProps/app.xml': strToU8(APP),
      'word/document.xml': strToU8(document),
      'word/styles.xml': strToU8(STYLES),
      'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELS)
    },
    { level: 6 }
  )
}
