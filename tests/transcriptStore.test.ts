import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { TranscriptFile } from '@shared/types'
import { loadTranscriptFile, updateTranscript } from '@main/transcriptStore'
import { lecturePaths } from '@main/storage/paths'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recture-store-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function transcript(pass: 'final' | 'live-draft' = 'final'): TranscriptFile {
  return {
    version: 1,
    lectureId: 'l1',
    classId: 'c1',
    className: 'Linear Algebra',
    lectureTitle: 'Week 3',
    recordedAt: '2026-09-12T14:00:00.000Z',
    durationSec: 4,
    source: { pass, provider: 'stub', model: 'stub', language: 'en' },
    createdAt: '2026-09-12T15:00:00.000Z',
    updatedAt: '2026-09-12T15:00:00.000Z',
    segments: [{ id: 'a', start: 0, end: 4, speaker: 'Speaker 1', text: 'hello', words: [] }],
    suggestions: [],
    excludedAudioSegments: []
  }
}

async function write(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value), 'utf8')
}

const read = async (file: string): Promise<TranscriptFile> => JSON.parse(await fs.readFile(file, 'utf8')) as TranscriptFile

describe('updateTranscript', () => {
  it('saves a change to the final transcript', async () => {
    await write(lecturePaths(dir).transcript, transcript())
    const next = await updateTranscript(dir, (t) => ({ ...t, lectureTitle: 'Renamed' }))
    expect(next.lectureTitle).toBe('Renamed')
    expect((await read(lecturePaths(dir).transcript)).lectureTitle).toBe('Renamed')
  })

  it('changes the live draft when there is no final transcript yet', async () => {
    await write(lecturePaths(dir).liveTranscript, transcript('live-draft'))
    await updateTranscript(dir, (t) => ({ ...t, lectureTitle: 'Draft corrected' }))
    expect((await read(lecturePaths(dir).liveTranscript)).lectureTitle).toBe('Draft corrected')
    await expect(fs.stat(lecturePaths(dir).transcript)).rejects.toThrow()
    expect((await loadTranscriptFile(dir))?.filePath).toBe(lecturePaths(dir).liveTranscript)
  })

  it('never loses one of several changes made at the same moment', async () => {
    // Regression: each change read the file, changed its copy and wrote it
    // back, so near-simultaneous changes overwrote one another.
    await write(lecturePaths(dir).transcript, transcript())
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        updateTranscript(dir, (t) => ({ ...t, speakerNames: { ...(t.speakerNames ?? {}), [`S${i}`]: `Name ${i}` } }))
      )
    )
    expect(Object.keys((await read(lecturePaths(dir).transcript)).speakerNames ?? {})).toHaveLength(25)
  })

  it('leaves the file untouched when a change fails, and keeps working afterwards', async () => {
    const file = lecturePaths(dir).transcript
    await write(file, transcript())
    const before = await fs.readFile(file, 'utf8')

    await expect(
      updateTranscript(dir, () => {
        throw new Error('That part of the transcript no longer exists.')
      })
    ).rejects.toThrow('no longer exists')
    expect(await fs.readFile(file, 'utf8')).toBe(before)

    await updateTranscript(dir, (t) => ({ ...t, lectureTitle: 'After' }))
    expect((await read(file)).lectureTitle).toBe('After')
  })

  it('does not rewrite the file when nothing changed', async () => {
    const file = lecturePaths(dir).transcript
    await write(file, transcript())
    const { mtimeMs } = await fs.stat(file)
    await new Promise((resolve) => setTimeout(resolve, 25))
    await updateTranscript(dir, (t) => t)
    expect((await fs.stat(file)).mtimeMs).toBe(mtimeMs)
  })

  it('explains when a lecture has no transcript at all', async () => {
    await expect(updateTranscript(dir, (t) => t)).rejects.toThrow(/no transcript yet/)
    expect(await loadTranscriptFile(dir)).toBeNull()
  })
})
