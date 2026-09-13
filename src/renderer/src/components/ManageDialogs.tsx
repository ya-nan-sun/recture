import { useState, type ReactNode } from 'react'
import type { ClassRecord } from '@shared/types'
import { Modal } from './common'

export function RenameDialog({
  title,
  label,
  initial,
  hint,
  onClose,
  onSubmit
}: {
  title: string
  label: string
  initial: string
  hint?: string
  onClose: () => void
  onSubmit: (value: string) => void
}): ReactNode {
  const [value, setValue] = useState(initial)
  const unchanged = value.trim() === initial.trim()

  return (
    <Modal title={title} onClose={onClose}>
      <label htmlFor="rename-input">{label}</label>
      <input
        id="rename-input"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim() && !unchanged) onSubmit(value.trim())
        }}
      />
      {hint && <p className="faint">{hint}</p>}
      <div className="row" style={{ marginTop: 14 }}>
        <div className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!value.trim() || unchanged} onClick={() => onSubmit(value.trim())}>
          Rename
        </button>
      </div>
    </Modal>
  )
}

export function MoveLectureDialog({
  classes,
  currentClassId,
  lectureTitle,
  onClose,
  onSubmit
}: {
  classes: ClassRecord[]
  currentClassId: string
  lectureTitle: string
  onClose: () => void
  onSubmit: (classId: string) => void
}): ReactNode {
  const options = classes.filter((c) => c.id !== currentClassId)
  const [target, setTarget] = useState(options[0]?.id ?? '')

  return (
    <Modal title="Move lecture" onClose={onClose}>
      {options.length === 0 ? (
        <p className="muted">There is no other class to move “{lectureTitle}” into. Create one first.</p>
      ) : (
        <>
          <label htmlFor="move-target">Move “{lectureTitle}” to</label>
          <select id="move-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <p className="faint">The lecture folder, its audio and its transcripts all move with it.</p>
        </>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <div className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!target} onClick={() => onSubmit(target)}>
          Move
        </button>
      </div>
    </Modal>
  )
}

/**
 * Destructive confirmation.
 *
 * Removing something from the library is reversible — the folder stays on
 * disk and can be re-added. Erasing the recordings is not, so that path is
 * opt-in, off by default, and additionally gated behind typing the name. The
 * dialog states plainly which of the two is about to happen.
 */
export function DeleteDialog({
  kind,
  name,
  folder,
  lectureCount,
  onClose,
  onConfirm
}: {
  kind: 'class' | 'lecture'
  name: string
  folder: string
  lectureCount?: number
  onClose: () => void
  onConfirm: (deleteFiles: boolean) => void
}): ReactNode {
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [typed, setTyped] = useState('')
  const confirmed = !deleteFiles || typed.trim() === name

  return (
    <Modal title={kind === 'class' ? 'Remove class' : 'Remove lecture'} onClose={onClose}>
      <p style={{ marginTop: 0 }}>
        Remove <strong>{name}</strong>
        {kind === 'class' && lectureCount !== undefined && (
          <>
            {' '}
            and its {lectureCount} lecture{lectureCount === 1 ? '' : 's'}
          </>
        )}{' '}
        from your library?
      </p>

      <div className="banner info">
        {deleteFiles ? (
          <>
            <strong>The recordings will be permanently deleted.</strong> Audio, transcripts and exports in this
            folder are erased and cannot be recovered from inside the app.
          </>
        ) : (
          <>
            <strong>Your recordings stay on disk.</strong> Only the library entry is removed — everything in the
            folder below is left exactly as it is.
          </>
        )}
        <div className="mono faint" style={{ marginTop: 8, wordBreak: 'break-all' }}>
          {folder}
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14 }}>
        <input
          type="checkbox"
          style={{ width: 'auto', marginTop: 3 }}
          checked={deleteFiles}
          onChange={(e) => {
            setDeleteFiles(e.target.checked)
            setTyped('')
          }}
        />
        <span>
          Also delete the audio and transcripts from disk
          <br />
          <span className="faint">This cannot be undone.</span>
        </span>
      </label>

      {deleteFiles && (
        <div style={{ marginTop: 12 }}>
          <label htmlFor="confirm-name">
            Type <strong>{name}</strong> to confirm
          </label>
          <input id="confirm-name" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <div className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button className="danger" disabled={!confirmed} onClick={() => onConfirm(deleteFiles)}>
          {deleteFiles ? 'Delete permanently' : 'Remove from library'}
        </button>
      </div>
    </Modal>
  )
}
