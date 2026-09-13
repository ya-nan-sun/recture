import type { ExportExtras, ExportOptions, TranscriptFile } from '@shared/types'
import { formatClock } from '@shared/naming'
import { readableParagraphs } from '@shared/transcript'
import { formatLectureDate, type ExportDocument } from '@shared/exportFormats'

export interface MarkdownLayout {
  /** 1 for a lecture on its own; 2 when it is one section of a class document. */
  headingLevel?: 1 | 2
}

/** Markdown export, generated from transcript.json (and the lecture's bookmarks) and nothing else. */
export function transcriptToMarkdown(
  transcript: TranscriptFile,
  options: ExportOptions,
  extras: ExportExtras = {},
  layout: MarkdownLayout = {}
): string {
  const level = layout.headingLevel ?? 1
  const lines: string[] = []

  lines.push(`${'#'.repeat(level)} ${transcript.lectureTitle}`)
  lines.push('')
  lines.push(`**${transcript.className}** · ${formatLectureDate(transcript.recordedAt)}`)
  const meta = [
    transcript.durationSec > 0 ? `Duration ${formatClock(transcript.durationSec)}` : null,
    `Transcribed by ${transcript.source.provider} (${transcript.source.model})`,
    transcript.source.pass === 'live-draft' ? '**Live draft — not a final transcript**' : null
  ].filter(Boolean)
  lines.push('')
  lines.push(meta.join(' · '))

  if (transcript.excludedAudioSegments.length > 0) {
    lines.push('')
    lines.push(
      `> ⚠️ ${transcript.excludedAudioSegments.length} audio segment(s) failed integrity checks and were excluded ` +
        'from this transcript. Some of the lecture may be missing.'
    )
  }

  const pending = transcript.suggestions.filter((s) => s.status === 'pending').length
  if (pending > 0) {
    lines.push('')
    lines.push(`> ${pending} glossary suggestion(s) are still awaiting review in the app.`)
  }

  const bookmarks = options.includeBookmarks ? [...(extras.bookmarks ?? [])].sort((a, b) => a.atSec - b.atSec) : []
  if (bookmarks.length > 0) {
    lines.push('')
    lines.push(`${'#'.repeat(level + 1)} Bookmarks`)
    lines.push('')
    for (const bookmark of bookmarks) {
      lines.push(`- \`${formatClock(bookmark.atSec)}\` ${bookmark.note.trim() || '_Bookmarked moment_'}`)
    }
  }

  lines.push('')
  lines.push('---')
  lines.push('')

  for (const p of readableParagraphs(transcript, options)) {
    const prefix: string[] = []
    if (options.includeTimestamps) prefix.push(`\`[${formatClock(p.start)}]\``)
    if (p.speaker) prefix.push(`**${p.speaker}:**`)
    lines.push(prefix.length > 0 ? `${prefix.join(' ')} ${p.text}` : p.text)
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** A whole class as one Markdown document: contents, then each lecture as a section. */
export function lecturesToMarkdown(className: string, documents: ExportDocument[], options: ExportOptions): string {
  const lines = [
    `# ${className}`,
    '',
    `${documents.length} lecture${documents.length === 1 ? '' : 's'}`,
    '',
    '## Contents',
    ''
  ]
  for (const { transcript } of documents) {
    lines.push(`- ${transcript.lectureTitle} · ${formatLectureDate(transcript.recordedAt)}`)
  }
  const sections = documents.map((d) =>
    transcriptToMarkdown(d.transcript, options, d.extras, { headingLevel: 2 }).trimEnd()
  )
  return `${lines.join('\n')}\n\n---\n\n${sections.join('\n\n---\n\n')}\n`
}
