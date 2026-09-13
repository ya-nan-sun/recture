import { useState, type ReactNode } from 'react'
import type { ExportOptions } from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ORDER,
  type ClassExportLayout,
  type ExportFormat
} from '@shared/exportFormats'
import { Modal } from './common'

export interface ClassExportRequest {
  format: ExportFormat
  layout: ClassExportLayout
  options: ExportOptions
}

/** Export every transcribed lecture in a class, in one file or a file each. */
export function ExportClassDialog({
  className,
  lectureCount,
  transcribedCount,
  onClose,
  onExport
}: {
  className: string
  lectureCount: number
  transcribedCount: number
  onClose: () => void
  onExport: (request: ClassExportRequest) => void
}): ReactNode {
  const [format, setFormat] = useState<ExportFormat>('markdown')
  const [layout, setLayout] = useState<ClassExportLayout>('single')
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const info = EXPORT_FORMATS[format]
  // Subtitles are timed to one recording, so they only ever go one per lecture.
  const effectiveLayout: ClassExportLayout = info.combinable ? layout : 'per-lecture'
  const nothingToExport = transcribedCount === 0

  return (
    <Modal title={`Export ${className}`} onClose={onClose}>
      {nothingToExport ? (
        <p className="muted" style={{ marginTop: 0 }}>
          None of the lectures in this class has a transcript yet.
        </p>
      ) : (
        <div className="stack">
          <div>
            <label htmlFor="class-export-format">Format</label>
            <select id="class-export-format" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
              {EXPORT_FORMAT_ORDER.map((f) => (
                <option key={f} value={f}>
                  {EXPORT_FORMATS[f].label}
                </option>
              ))}
            </select>
            <div className="faint" style={{ marginTop: 6 }}>
              {info.hint}
            </div>
          </div>

          <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label="Files">
            <label className="check">
              <input
                type="radio"
                name="class-export-layout"
                checked={effectiveLayout === 'single'}
                disabled={!info.combinable}
                onChange={() => setLayout('single')}
              />
              One file with every lecture
            </label>
            <label className="check">
              <input
                type="radio"
                name="class-export-layout"
                checked={effectiveLayout === 'per-lecture'}
                onChange={() => setLayout('per-lecture')}
              />
              A separate file for each lecture
            </label>
            {!info.combinable && (
              <span className="faint">Subtitles are timed to one recording, so each lecture gets its own file.</span>
            )}
          </div>

          <div className="row wrap" style={{ gap: 14 }}>
            <label className="check">
              <input
                type="checkbox"
                checked={options.includeTimestamps}
                onChange={(e) => setOptions({ ...options, includeTimestamps: e.target.checked })}
              />
              Timestamps
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={options.removeFillers}
                onChange={(e) => setOptions({ ...options, removeFillers: e.target.checked })}
              />
              Hide “um” and “uh”
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={options.includeBookmarks}
                onChange={(e) => setOptions({ ...options, includeBookmarks: e.target.checked })}
              />
              Bookmarks
            </label>
          </div>

          <div className="faint">
            {transcribedCount === lectureCount
              ? `All ${lectureCount} lecture${lectureCount === 1 ? '' : 's'} will be exported, oldest first.`
              : `${transcribedCount} of ${lectureCount} lectures have a transcript and will be exported, oldest first.`}
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <div className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={nothingToExport}
          onClick={() => onExport({ format, layout: effectiveLayout, options })}
        >
          Export…
        </button>
      </div>
    </Modal>
  )
}
