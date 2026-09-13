import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  ClassRecord,
  CorrectionSuggestion,
  ExportOptions,
  ImportProgress,
  LectureRecord,
  TranscriptFile,
  TranscriptionProgress,
  TranscriptionQueueSnapshot
} from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { formatClock } from '@shared/naming'
import { materializeTranscript, toParagraphs } from '@shared/transcript'
import { Empty, StatusChip } from './common'
import { DeleteDialog, MoveLectureDialog, RenameDialog } from './ManageDialogs'

interface Props {
  lecture: LectureRecord
  classes: ClassRecord[]
  progress: TranscriptionProgress | null
  /** What the transcription queue is doing; authoritative over a stale status. */
  queue?: TranscriptionQueueSnapshot | null
  /** Progress of the import creating this lecture, while it runs. */
  importProgress?: ImportProgress | null
  onToast: (message: string) => void
  onChanged: () => void
  /** Called after the lecture leaves the library, so the view can navigate away. */
  onRemoved: () => void
}

export function LectureView({
  lecture,
  classes,
  progress,
  queue,
  importProgress,
  onToast,
  onChanged,
  onRemoved
}: Props): ReactNode {
  const [renaming, setRenaming] = useState(false)
  const [moving, setMoving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [sections, setSections] = useState<{ label: string; text: string }[] | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTranscript(await window.recture.transcript.get(lecture.id))
      setAudioUrl(await window.recture.transcript.audioUrl(lecture.id))
    } finally {
      setLoading(false)
    }
  }, [lecture.id])

  useEffect(() => {
    void load()
  }, [load])

  // Hold the latest callback without making the effect depend on its identity.
  // The parent passes a fresh function on every render; depending on it caused
  // a render loop that flickered the view between the transcript and
  // a loading screen for as long as the lecture stayed open.
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  // Progress stays latched at `done`/`failed` after a pass finishes, so react to
  // each completion *event* exactly once. Anything that finished before this
  // view mounted is already covered by the initial load.
  const handledProgressRef = useRef(progress)

  // Reload when the pipeline finishes for this lecture.
  useEffect(() => {
    if (!progress || progress === handledProgressRef.current) return
    if (progress.lectureId !== lecture.id) return
    if (progress.phase !== 'done' && progress.phase !== 'failed') return
    handledProgressRef.current = progress
    void load()
    onChangedRef.current()
  }, [progress, lecture.id, load])

  const paragraphs = useMemo(() => {
    if (!transcript) return []
    const source = options.applyAcceptedSuggestions ? materializeTranscript(transcript) : transcript
    return toParagraphs(source.segments, options.paragraphSeconds)
  }, [transcript, options])

  const pending = transcript?.suggestions.filter((s) => s.status === 'pending') ?? []

  const seek = (seconds: number): void => {
    const el = audioRef.current
    if (!el) return
    el.currentTime = seconds
    void el.play().catch(() => undefined)
  }

  const setSuggestion = async (suggestion: CorrectionSuggestion, status: 'accepted' | 'rejected'): Promise<void> => {
    try {
      setTranscript(await window.recture.transcript.setSuggestion(lecture.id, suggestion.id, status))
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  const doExport = async (kind: 'markdown' | 'pdf' | 'clipboard'): Promise<void> => {
    try {
      if (kind === 'clipboard') {
        const result = await window.recture.exports.clipboard(lecture.id, options)
        if (result.copied) onToast(`Copied ${result.length.toLocaleString()} characters.`)
        else {
          setSections(result.sections ?? [])
          onToast('This transcript is long — copy it in sections.')
        }
        return
      }
      const path = kind === 'markdown'
        ? await window.recture.exports.markdown(lecture.id, options)
        : await window.recture.exports.pdf(lecture.id, options)
      onToast(`Saved ${path}`)
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  // The queue is authoritative about what is running. The lecture status alone
  // can be stale, e.g. left over from a pass the app was closed during.
  const lectureProgress = progress?.lectureId === lecture.id ? progress : null
  const isRunning = queue
    ? queue.running?.lectureId === lecture.id
    : lecture.status === 'transcribing' || lecture.status === 'assembling'
  const waitingPosition = queue ? queue.waiting.indexOf(lecture.id) : -1
  const inQueue = isRunning || waitingPosition >= 0
  // Claims to be in progress but is not actually queued: always leave a way out.
  const stranded =
    !inQueue && (lecture.status === 'queued' || lecture.status === 'transcribing' || lecture.status === 'assembling')
  const canRetry =
    !inQueue &&
    (lecture.status === 'needs_transcription' ||
      lecture.status === 'needs_attention' ||
      transcript?.source.pass === 'live-draft' ||
      stranded)

  const cancelTranscription = async (message: string): Promise<void> => {
    try {
      await window.recture.transcription.cancel(lecture.id)
      onToast(message)
      onChangedRef.current()
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  const cancelImport = async (): Promise<void> => {
    try {
      // The import removes the lecture it was creating; the parent navigates away.
      await window.recture.lectures.cancelImport(lecture.id)
      onChangedRef.current()
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="main-inner">
      <div className="row" style={{ marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>{lecture.title}</h1>
        <div className="spacer" />
        <StatusChip lecture={lecture} />
      </div>
      <p className="subtitle">
        {new Date(lecture.recordedAt).toLocaleString()} · {formatClock(lecture.durationSec)}
        {lecture.segmentCount > 0 ? ` · ${lecture.segmentCount} segment${lecture.segmentCount === 1 ? '' : 's'}` : ''}
        {lecture.transcriptSource ? ` · ${lecture.transcriptSource}` : ''}
      </p>

      {lecture.statusDetail && lecture.status !== 'importing' && (
        <div className={`banner ${lecture.status === 'complete' ? 'info' : 'warn'}`}>{lecture.statusDetail}</div>
      )}

      {transcript?.source.pass === 'live-draft' && (
        <div className="banner warn">
          This is the <strong>live draft</strong>, not a final transcript. It is noticeably less accurate. Retry
          transcription to replace it.
        </div>
      )}

      {(transcript?.excludedAudioSegments.length ?? 0) > 0 && (
        <div className="banner danger">
          {transcript!.excludedAudioSegments.length} audio segment(s) failed their integrity check and were excluded
          from this transcript. The files are still on disk, in this lecture’s <code>audio</code> folder.
        </div>
      )}

      {lecture.status === 'importing' && (
        <div className="card" data-testid="import-progress">
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>{importProgress?.message ?? lecture.statusDetail ?? 'Importing…'}</strong>
            <div className="spacer" />
            {importProgress && importProgress.processedSec > 0 && (
              <span className="faint mono">{formatClock(importProgress.processedSec)}</span>
            )}
            <button className="ghost" onClick={() => void cancelImport()}>
              Cancel
            </button>
          </div>
          <div className="progress">
            <div
              className="progress-fill"
              style={{ width: `${Math.round((importProgress?.fraction ?? 0.03) * 100)}%` }}
            />
          </div>
          <div className="faint" style={{ marginTop: 8 }}>
            The original file is not changed. Transcription starts as soon as the import finishes.
          </div>
        </div>
      )}

      {isRunning && (
        <div className="card">
          <div className="row" style={{ marginBottom: 8 }}>
            <strong>{lectureProgress?.message ?? 'Transcribing…'}</strong>
            <div className="spacer" />
            {lectureProgress?.attempt && lectureProgress.attempt > 1 && (
              <span className="chip warn">Attempt {lectureProgress.attempt}</span>
            )}
            <button className="ghost" onClick={() => void cancelTranscription('Transcription stopped.')}>
              Stop
            </button>
          </div>
          <div className="progress">
            <div
              className="progress-fill"
              style={{ width: `${Math.round((lectureProgress?.progress ?? 0.05) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {waitingPosition >= 0 && (
        <div className="banner info">
          <div className="row">
            <span>
              Waiting to transcribe · #{waitingPosition + 1} in line
              {queue?.running ? ', after the lecture being transcribed now' : ''}.
            </span>
            <div className="spacer" />
            <button onClick={() => void cancelTranscription('Removed from the transcription queue.')}>Cancel</button>
          </div>
        </div>
      )}

      <div className="row wrap" style={{ marginBottom: 14, gap: 8 }}>
        <button onClick={() => void doExport('markdown')} disabled={!transcript}>
          Export Markdown
        </button>
        <button onClick={() => void doExport('pdf')} disabled={!transcript}>
          Export PDF
        </button>
        <button onClick={() => void doExport('clipboard')} disabled={!transcript}>
          Copy text
        </button>
        <div className="spacer" />
        <button onClick={() => setRenaming(true)}>Rename</button>
        <button onClick={() => setMoving(true)}>Move…</button>
        <button className="danger" onClick={() => setDeleting(true)}>
          Remove
        </button>
        <button onClick={() => void window.recture.lectures.reveal(lecture.id)}>Open folder</button>
        {canRetry && (
          <button
            className="primary"
            onClick={async () => {
              try {
                const result = await window.recture.transcript.retry(lecture.id)
                onToast(
                  result.position > 0
                    ? `Queued for transcription (#${result.position} in line).`
                    : 'Transcription started.'
                )
                onChanged()
              } catch (err) {
                onToast(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            Retry transcription
          </button>
        )}
      </div>

      <div className="row wrap" style={{ marginBottom: 16, gap: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={options.includeTimestamps}
            onChange={(e) => setOptions({ ...options, includeTimestamps: e.target.checked })}
          />
          Timestamps
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={options.applyAcceptedSuggestions}
            onChange={(e) => setOptions({ ...options, applyAcceptedSuggestions: e.target.checked })}
          />
          Apply accepted corrections
        </label>
      </div>

      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          controls
          style={{ width: '100%', marginBottom: 16 }}
          onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
        />
      )}

      {pending.length > 0 && (
        <>
          <h2>
            Glossary review <span className="chip warn">{pending.length} to check</span>
          </h2>
          <p className="faint" style={{ marginTop: -4, marginBottom: 10 }}>
            These spans look like misheard course terms. Nothing is changed until you accept it.
          </p>
          {pending.map((s) => (
            <div className="suggestion-card" key={s.id}>
              <div className="suggestion-diff">
                <span className="from mono">{s.original}</span>
                <span className="faint">→</span>
                <span className="to mono">{s.suggested}</span>
                <span className="faint">at {formatClock(s.start)}</span>
              </div>
              <div className="faint" style={{ marginBottom: 8 }}>
                {s.reason}
              </div>
              <div className="row">
                <button onClick={() => void setSuggestion(s, 'accepted')}>Accept</button>
                <button className="ghost" onClick={() => void setSuggestion(s, 'rejected')}>
                  Reject
                </button>
                <button className="ghost" onClick={() => seek(s.start)}>
                  Listen
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {sections && (
        <>
          <h2>Copy by section</h2>
          {sections.map((section) => (
            <div className="row" key={section.label} style={{ marginBottom: 6 }}>
              <span className="mono faint" style={{ width: 130 }}>
                {section.label}
              </span>
              <button
                onClick={async () => {
                  await window.recture.exports.copyText(section.text)
                  onToast(`Copied ${section.label}.`)
                }}
              >
                Copy
              </button>
            </div>
          ))}
        </>
      )}

      <h2>Transcript</h2>
      {loading && !transcript ? (
        <Empty title="Loading…" />
      ) : !transcript ? (
        <Empty
          title="No transcript yet"
          detail={
            lecture.status === 'needs_transcription'
              ? 'The audio is safe on disk. Use “Retry transcription” above.'
              : lecture.status === 'importing'
                ? 'It will appear here once the file is imported and transcribed.'
                : 'It will appear here once the final pass finishes.'
          }
        />
      ) : (
        paragraphs.map((p, i) => {
          const playing = playhead >= p.start && playhead < p.end
          return (
            <div className={`para${playing ? ' playing' : ''}`} key={`${p.start}-${i}`}>
              <span className="para-time" onClick={() => seek(p.start)} title="Jump to this moment">
                {formatClock(p.start)}
              </span>
              <span className="para-text">
                {p.speaker && <strong>{p.speaker}: </strong>}
                {p.text}
              </span>
            </div>
          )
        })
      )}

      {renaming && (
        <RenameDialog
          title="Rename lecture"
          label="Lecture title"
          initial={lecture.title}
          hint="The lecture folder is renamed to match, keeping the recording date prefix."
          onClose={() => setRenaming(false)}
          onSubmit={async (title) => {
            setRenaming(false)
            try {
              await window.recture.lectures.rename(lecture.id, title)
              onChanged()
              onToast('Lecture renamed.')
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      {moving && (
        <MoveLectureDialog
          classes={classes}
          currentClassId={lecture.classId}
          lectureTitle={lecture.title}
          onClose={() => setMoving(false)}
          onSubmit={async (classId) => {
            setMoving(false)
            try {
              await window.recture.lectures.move(lecture.id, classId)
              onChanged()
              onToast('Lecture moved.')
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      {deleting && (
        <DeleteDialog
          kind="lecture"
          name={lecture.title}
          folder={lecture.dirPath}
          onClose={() => setDeleting(false)}
          onConfirm={async (deleteFiles) => {
            setDeleting(false)
            try {
              const result = await window.recture.lectures.remove(lecture.id, deleteFiles)
              onToast(
                result.filesDeleted
                  ? `Deleted ${lecture.title} and its audio.`
                  : `Removed ${lecture.title} from the library. The recording is still in ${result.folder}.`
              )
              onRemoved()
            } catch (err) {
              onToast(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}
    </div>
  )
}
