import { useEffect, useState } from 'react'
import type { ImportProgress } from '@shared/types'

/**
 * Imports in progress, by lecture id. A failed or cancelled import is announced
 * once, since its lecture disappears along with it.
 */
export function useImports(notify: (message: string) => void): Record<string, ImportProgress> {
  const [imports, setImports] = useState<Record<string, ImportProgress>>({})

  useEffect(() => {
    return window.recture.events.onImportProgress((progress) => {
      setImports((current) => {
        const next = { ...current }
        if (progress.phase === 'waiting' || progress.phase === 'importing') next[progress.lectureId] = progress
        else delete next[progress.lectureId]
        return next
      })
      if (progress.phase === 'failed' || progress.phase === 'cancelled') notify(progress.message)
    })
  }, [notify])

  return imports
}
