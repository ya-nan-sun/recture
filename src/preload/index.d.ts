import type { LectureRecApi } from './index'

declare global {
  interface Window {
    lecturerec: LectureRecApi
  }
}

export {}
