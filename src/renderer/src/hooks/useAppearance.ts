import { useEffect } from 'react'
import type { ThemeSetting } from '@shared/types'
import { clampFontSize, resolveTheme } from '@shared/reading'

/** Apply the colour scheme and transcript text size to the whole window. */
export function useAppearance(theme: ThemeSetting, transcriptFontSize: number): void {
  useEffect(() => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const apply = (): void => {
      document.documentElement.dataset.theme = resolveTheme(theme, media?.matches ?? true)
    }
    apply()
    if (theme !== 'system' || !media) return
    // Follow the operating system when it switches between light and dark.
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    document.documentElement.style.setProperty('--transcript-font-size', `${clampFontSize(transcriptFontSize)}px`)
  }, [transcriptFontSize])
}
