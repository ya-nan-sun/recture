import { describe, expect, it } from 'vitest'
import { SEARCH_MARK_END as END, SEARCH_MARK_START as START } from '@shared/types'
import {
  FONT_SIZE_RANGE,
  buildOutline,
  clampFontSize,
  findMatches,
  highlightParts,
  normalizePlaybackRate,
  playbackKeyAction,
  resolveTheme,
  sectionLabel,
  snippetParts,
  stepPlaybackRate,
  type PlaybackAction
} from '@shared/reading'

describe('findMatches', () => {
  it('finds every occurrence, ignoring case, in reading order', () => {
    expect(findMatches(['The matrix and the MATRIX', 'no match here', 'matrix'], 'matrix')).toEqual([
      { pieceIndex: 0, start: 4, end: 10 },
      { pieceIndex: 0, start: 19, end: 25 },
      { pieceIndex: 2, start: 0, end: 6 }
    ])
  })

  it('ignores queries too short to be useful', () => {
    expect(findMatches(['a b c'], ' a ')).toEqual([])
  })

  it('does not count overlapping matches twice', () => {
    expect(findMatches(['aaaa'], 'aa')).toHaveLength(2)
  })
})

describe('highlightParts', () => {
  it('splits text around its matches', () => {
    expect(highlightParts('Eigen values and eigenvectors', 'eigen')).toEqual([
      { text: 'Eigen', match: true },
      { text: ' values and ', match: false },
      { text: 'eigen', match: true },
      { text: 'vectors', match: false }
    ])
  })

  it('returns the text whole when nothing matches', () => {
    expect(highlightParts('nothing here', 'matrix')).toEqual([{ text: 'nothing here', match: false }])
    expect(highlightParts('nothing here', '')).toEqual([{ text: 'nothing here', match: false }])
  })
})

describe('snippetParts', () => {
  it('splits a search snippet at its match markers', () => {
    expect(snippetParts(`…the ${START}matrix${END} is ${START}square${END}`)).toEqual([
      { text: '…the ', match: false },
      { text: 'matrix', match: true },
      { text: ' is ', match: false },
      { text: 'square', match: true }
    ])
  })

  it('keeps markup in a transcript as plain text', () => {
    // Regression: snippets were turned into HTML, so transcript text could inject markup.
    expect(snippetParts(`<img src=x onerror=alert(1)> [brackets] ${START}b${END}`)).toEqual([
      { text: '<img src=x onerror=alert(1)> [brackets] ', match: false },
      { text: 'b', match: true }
    ])
  })
})

describe('outline', () => {
  it('labels a section by how it starts', () => {
    expect(sectionLabel('Today we are going to talk about eigenvalues and what they mean')).toBe(
      'Today we are going to talk about eigenvalues…'
    )
    expect(sectionLabel('Short one.')).toBe('Short one.')
  })

  it('ends a label cleanly rather than on a comma', () => {
    expect(sectionLabel('First, second, third, fourth, fifth, sixth, seventh, eighth, ninth')).toBe(
      'First, second, third, fourth, fifth, sixth, seventh, eighth…'
    )
  })

  it('starts a section every five minutes, at the start of a paragraph', () => {
    const paragraphs = [
      { start: 0, text: 'Welcome' },
      { start: 120, text: 'Still the introduction' },
      { start: 310, text: 'Vectors begin here' },
      { start: 590, text: 'More vectors' },
      { start: 605, text: 'Matrices now' }
    ]
    expect(buildOutline(paragraphs, []).map((e) => [e.atSec, e.label])).toEqual([
      [0, 'Welcome'],
      [310, 'Vectors begin here'],
      [605, 'Matrices now']
    ])
  })

  it('includes bookmarks, ahead of a section at the same moment', () => {
    const outline = buildOutline(
      [{ start: 0, text: 'Welcome' }],
      [
        { id: 'b2', atSec: 42, note: ' on the exam ', createdAt: '' },
        { id: 'b1', atSec: 0, note: '', createdAt: '' }
      ]
    )
    expect(outline.map((e) => [e.kind, e.label])).toEqual([
      ['bookmark', 'Bookmarked moment'],
      ['section', 'Welcome'],
      ['bookmark', 'on the exam']
    ])
  })
})

describe('playback keys', () => {
  const cases: [string, PlaybackAction | null][] = [
    [' ', { type: 'toggle' }],
    ['k', { type: 'toggle' }],
    ['ArrowLeft', { type: 'seek', delta: -5 }],
    ['ArrowRight', { type: 'seek', delta: 5 }],
    ['j', { type: 'seek', delta: -15 }],
    ['L', { type: 'seek', delta: 15 }],
    ['[', { type: 'rate', direction: -1 }],
    [']', { type: 'rate', direction: 1 }],
    ['x', null]
  ]

  it.each(cases)('"%s"', (key, expected) => {
    expect(playbackKeyAction({ key, targetTag: 'DIV' })).toEqual(expected)
  })

  it('leaves keys alone while typing, or when a control has focus', () => {
    for (const targetTag of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'input']) {
      expect(playbackKeyAction({ key: ' ', targetTag })).toBeNull()
    }
    expect(playbackKeyAction({ key: ' ', targetTag: 'DIV', targetEditable: true })).toBeNull()
  })

  it('leaves shortcuts with modifier keys to the app', () => {
    expect(playbackKeyAction({ key: 'f', ctrlKey: true })).toBeNull()
    expect(playbackKeyAction({ key: 'ArrowLeft', altKey: true })).toBeNull()
    expect(playbackKeyAction({ key: 'k', metaKey: true })).toBeNull()
  })
})

describe('playback speed', () => {
  it('steps through the offered speeds and stops at either end', () => {
    expect(stepPlaybackRate(1, 1)).toBe(1.25)
    expect(stepPlaybackRate(1, -1)).toBe(0.75)
    expect(stepPlaybackRate(2, 1)).toBe(2)
    expect(stepPlaybackRate(0.75, -1)).toBe(0.75)
    expect(stepPlaybackRate(1.3, 1)).toBe(1.5)
  })

  it('only accepts speeds the player offers', () => {
    expect(normalizePlaybackRate(1.5)).toBe(1.5)
    expect(normalizePlaybackRate('2')).toBe(2)
    expect(normalizePlaybackRate(16)).toBe(1)
    expect(normalizePlaybackRate(undefined)).toBe(1)
  })
})

describe('appearance', () => {
  it('follows the computer unless a theme was chosen', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
    expect(resolveTheme(undefined, false)).toBe('light')
  })

  it('keeps the transcript text size readable', () => {
    expect(clampFontSize(18)).toBe(18)
    expect(clampFontSize(4)).toBe(FONT_SIZE_RANGE.min)
    expect(clampFontSize(99)).toBe(FONT_SIZE_RANGE.max)
    expect(clampFontSize('abc')).toBe(FONT_SIZE_RANGE.default)
  })
})
