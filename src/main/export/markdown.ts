import type { ExportOptions, TranscriptFile } from '@shared/types'
import { formatClock } from '@shared/naming'
import { materializeTranscript, toParagraphs } from '@shared/transcript'

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

/** Markdown export, generated from transcript.json and nothing else. */
export function transcriptToMarkdown(transcript: TranscriptFile, options: ExportOptions): string {
  const source = options.applyAcceptedSuggestions ? materializeTranscript(transcript) : transcript
  const lines: string[] = []

  lines.push(`# ${transcript.lectureTitle}`)
  lines.push('')
  lines.push(`**${transcript.className}** · ${formatDate(transcript.recordedAt)}`)
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

  lines.push('')
  lines.push('---')
  lines.push('')

  for (const p of toParagraphs(source.segments, options.paragraphSeconds)) {
    const prefix: string[] = []
    if (options.includeTimestamps) prefix.push(`\`[${formatClock(p.start)}]\``)
    if (p.speaker) prefix.push(`**${p.speaker}:**`)
    lines.push(prefix.length > 0 ? `${prefix.join(' ')} ${p.text}` : p.text)
    lines.push('')
  }

  return `${lines.join('\n').trimEnd()}\n`
}
