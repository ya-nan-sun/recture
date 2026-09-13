import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { DiskSpace } from '@shared/types'

/**
 * Free and total space on the drive that holds `target`.
 *
 * The library folder may not exist yet on a fresh install, so this walks up to
 * the nearest folder that does. Returns null only if nothing could be read.
 */
export async function getDiskSpace(target: string): Promise<DiskSpace | null> {
  let current = path.resolve(target)
  for (let depth = 0; depth < 64; depth++) {
    try {
      const stats = await fs.statfs(current)
      return {
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize)
      }
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
  return null
}
