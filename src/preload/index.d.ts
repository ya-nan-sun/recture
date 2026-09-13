import type { RectureApi } from './index'

declare global {
  interface Window {
    recture: RectureApi
  }
}

export {}
