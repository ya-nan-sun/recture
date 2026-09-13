/**
 * Pure helpers for reading a lecture: finding text in it, highlighting, the
 * outline, search snippets, playback keys and appearance.
 */

import type { Bookmark, ThemeSetting } from './types'
import { SEARCH_MARK_END, SEARCH_MARK_START } from './types'

export interface TextPart {
  text: string
  match: boolean
}

/** Shorter queries match almost everything and help nobody. */
export const MIN_FIND_LENGTH = 2

export interface FindMatch {
  /** Which of the searched texts the match is in. */
  pieceIndex: number
  start: number
  end: number
}

/** Every case-insensitive occurrence of `query`, in reading order. */
export function findMatches(texts: string[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase()
  if (needle.length < MIN_FIND_LENGTH) return []
  const matches: FindMatch[] = []
  texts.forEach((text, pieceIndex) => {
    const haystack = text.toLowerCase()
    // A few characters change length when lower-cased, which would misplace
    // every highlight after them. Skipping that text is better than lying.
    if (haystack.length !== text.length) return
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      matches.push({ pieceIndex, start: at, end: at + needle.length })
    }
  })
  return matches
}

/** Split text into runs, marking the ones that match `query`. */
export function highlightParts(text: string, query: string): TextPart[] {
  const matches = findMatches([text], query)
  if (matches.length === 0) return [{ text, match: false }]
  const parts: TextPart[] = []
  let at = 0
  for (const match of matches) {
    if (match.start > at) parts.push({ text: text.slice(at, match.start), match: false })
    parts.push({ text: text.slice(match.start, match.end), match: true })
    at = match.end
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false })
  return parts
}

/** Split a search snippet at its match markers. The text is only ever text. */
export function snippetParts(snippet: string): TextPart[] {
  const parts: TextPart[] = []
  let buffer = ''
  let match = false
  for (const char of snippet) {
    if (char === SEARCH_MARK_START || char === SEARCH_MARK_END) {
      if (buffer) parts.push({ text: buffer, match })
      buffer = ''
      match = char === SEARCH_MARK_START
      continue
    }
    buffer += char
  }
  if (buffer) parts.push({ text: buffer, match })
  return parts
}

// --- outline -------------------------------------------------------------------

export interface OutlineEntry {
  id: string
  kind: 'section' | 'bookmark'
  atSec: number
  label: string
}

export const OUTLINE_SECTION_SECONDS = 300

/** The opening words of a passage, as a short label. */
export function sectionLabel(text: string, maxWords = 8, maxChars = 60): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const full = words.join(' ')
  let label = words.slice(0, maxWords).join(' ')
  if (label.length > maxChars) {
    const cut = label.slice(0, maxChars)
    label = cut.includes(' ') ? cut.replace(/\s+\S*$/, '') : cut
  }
  const truncated = label.length < full.length
  label = label.replace(/[,;:\-–—]+$/, '')
  return truncated ? `${label}…` : label
}

/**
 * A table of contents for a lecture: a section every few minutes, labelled by
 * how it starts, plus the moments the student bookmarked.
 */
export function buildOutline(
  paragraphs: { start: number; text: string }[],
  bookmarks: Bookmark[],
  sectionSeconds = OUTLINE_SECTION_SECONDS
): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  let nextBoundary = 0
  for (const paragraph of paragraphs) {
    if (paragraph.start < nextBoundary) continue
    entries.push({
      id: `section-${Math.round(paragraph.start * 1000)}`,
      kind: 'section',
      atSec: paragraph.start,
      label: sectionLabel(paragraph.text)
    })
    nextBoundary = (Math.floor(paragraph.start / sectionSeconds) + 1) * sectionSeconds
  }
  for (const bookmark of bookmarks) {
    entries.push({
      id: `bookmark-${bookmark.id}`,
      kind: 'bookmark',
      atSec: bookmark.atSec,
      label: bookmark.note.trim() || 'Bookmarked moment'
    })
  }
  // Bookmarks first when they share a moment with a section.
  return entries.sort((a, b) => a.atSec - b.atSec || (a.kind === b.kind ? 0 : a.kind === 'bookmark' ? -1 : 1))
}

// --- playback ------------------------------------------------------------------

export type PlaybackAction = { type: 'toggle' } | { type: 'seek'; delta: number } | { type: 'rate'; direction: 1 | -1 }

export interface KeyInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /** Tag name of the element that has focus. */
  targetTag?: string | null
  targetEditable?: boolean
}

/** Elements where a key press belongs to the element, not to the player. */
const OWNS_KEYS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'AUDIO', 'VIDEO'])

export function playbackKeyAction(input: KeyInput): PlaybackAction | null {
  if (input.ctrlKey || input.metaKey || input.altKey) return null
  if (input.targetEditable) return null
  if (input.targetTag && OWNS_KEYS.has(input.targetTag.toUpperCase())) return null
  switch (input.key) {
    case ' ':
    case 'k':
    case 'K':
      return { type: 'toggle' }
    case 'ArrowLeft':
      return { type: 'seek', delta: -5 }
    case 'ArrowRight':
      return { type: 'seek', delta: 5 }
    case 'j':
    case 'J':
      return { type: 'seek', delta: -15 }
    case 'l':
    case 'L':
      return { type: 'seek', delta: 15 }
    case '[':
      return { type: 'rate', direction: -1 }
    case ']':
      return { type: 'rate', direction: 1 }
    default:
      return null
  }
}

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

export function normalizePlaybackRate(rate: unknown): number {
  const value = Number(rate)
  return (PLAYBACK_RATES as readonly number[]).includes(value) ? value : 1
}

/** The next speed up or down from the one closest to `current`. */
export function stepPlaybackRate(current: number, direction: 1 | -1): number {
  const rates = PLAYBACK_RATES as readonly number[]
  let nearest = 0
  rates.forEach((rate, i) => {
    if (Math.abs(rate - current) < Math.abs(rates[nearest]! - current)) nearest = i
  })
  return rates[Math.min(rates.length - 1, Math.max(0, nearest + direction))]!
}

// --- appearance ----------------------------------------------------------------

export function resolveTheme(setting: ThemeSetting | undefined, prefersDark: boolean): 'dark' | 'light' {
  if (setting === 'dark' || setting === 'light') return setting
  return prefersDark ? 'dark' : 'light'
}

export const FONT_SIZE_RANGE = { min: 12, max: 24, default: 15 } as const

export function clampFontSize(size: unknown): number {
  const value = Math.round(Number(size))
  if (!Number.isFinite(value)) return FONT_SIZE_RANGE.default
  return Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, value))
}
