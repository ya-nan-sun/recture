import { describe, expect, it } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { getDiskSpace } from '@main/diskSpace'

describe('getDiskSpace', () => {
  it('reads free and total space for a folder', async () => {
    const space = await getDiskSpace(os.tmpdir())
    expect(space).not.toBeNull()
    expect(space!.freeBytes).toBeGreaterThan(0)
    expect(space!.totalBytes).toBeGreaterThanOrEqual(space!.freeBytes)
  })

  it('works for a library folder that has not been created yet', async () => {
    const notYet = path.join(os.tmpdir(), 'recture-not-created', 'Classes', 'CS 101')
    const space = await getDiskSpace(notYet)
    expect(space?.freeBytes).toBeGreaterThan(0)
  })
})
