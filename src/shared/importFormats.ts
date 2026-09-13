/**
 * Which files can be imported as a lecture: the formats students actually end
 * up with — phone voice memos, Zoom and Teams recordings, Panopto and lecture
 * capture downloads. ffmpeg reads the audio track out of any of them.
 */

export const IMPORT_EXTENSIONS = [
  'mp3',
  'm4a',
  'aac',
  'wav',
  'flac',
  'ogg',
  'oga',
  'opus',
  'wma',
  'aif',
  'aiff',
  'caf',
  'amr',
  '3gp',
  'webm',
  'mp4',
  'm4v',
  'mov',
  'mkv',
  'avi',
  'wmv'
] as const

export function isImportableFile(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return false
  return (IMPORT_EXTENSIONS as readonly string[]).includes(fileName.slice(dot + 1).toLowerCase())
}

export function partitionImportable<T extends { name: string }>(files: T[]): { accepted: T[]; skipped: T[] } {
  const accepted: T[] = []
  const skipped: T[] = []
  for (const file of files) (isImportableFile(file.name) ? accepted : skipped).push(file)
  return { accepted, skipped }
}

/** A note about dropped files that were left out, or null if none were. */
export function describeSkipped(names: string[]): string | null {
  if (names.length === 0) return null
  if (names.length === 1) return `Skipped ${names[0]}: only audio and video files can be imported.`
  return `Skipped ${names.length} files that aren't audio or video.`
}
