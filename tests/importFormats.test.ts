import { describe, expect, it } from 'vitest'
import { describeSkipped, isImportableFile, partitionImportable } from '@shared/importFormats'

describe('isImportableFile', () => {
  it('accepts the recordings students actually have', () => {
    for (const name of ['Voice memo.m4a', 'zoom_0.mp4', 'Lecture 3.MP3', 'panopto.mov', 'class.webm', 'a.flac']) {
      expect(isImportableFile(name)).toBe(true)
    }
  })

  it('rejects documents and files without an extension', () => {
    for (const name of ['slides.pdf', 'notes.docx', 'README', '.mp3', 'trailing.', 'archive.zip']) {
      expect(isImportableFile(name)).toBe(false)
    }
  })
})

describe('partitionImportable', () => {
  it('splits a drop into what can be imported and what cannot, keeping order', () => {
    const files = [{ name: 'a.mp3' }, { name: 'slides.pdf' }, { name: 'b.m4a' }]
    expect(partitionImportable(files)).toEqual({
      accepted: [{ name: 'a.mp3' }, { name: 'b.m4a' }],
      skipped: [{ name: 'slides.pdf' }]
    })
  })
})

describe('describeSkipped', () => {
  it('names a single skipped file, and counts several', () => {
    expect(describeSkipped([])).toBeNull()
    expect(describeSkipped(['slides.pdf'])).toBe('Skipped slides.pdf: only audio and video files can be imported.')
    expect(describeSkipped(['a.pdf', 'b.txt'])).toBe("Skipped 2 files that aren't audio or video.")
  })
})
