import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  Bookmark,
  ClassRecord,
  CorrectionSuggestion,
  ExportOptions,
  ImportProgress,
  LectureRecord,
  TranscriptFile,
  TranscriptSegment,
  TranscriptionProgress,
  TranscriptionQueueSnapshot
} from '@shared/types'
import { DEFAULT_EXPORT_OPTIONS } from '@shared/types'
import { formatClock } from '@shared/naming'
import { editedSegmentCount, materializeTranscript, readableParagraphs, speakersIn } from '@shared/transcript'
import {
  PLAYBACK_RATES,
  buildOutline,
  findMatches,
  highlightParts,
  normalizePlaybackRate,
  playbackKeyAction,
  stepPlaybackRate
} from '@shared/reading'
import { EXPORT_FORMATS, EXPORT_FORMAT_ORDER, type ExportFormat } from '@shared/exportFormats'
import { Empty, StatusChip } from './common'
import { DeleteDialog, MoveLectureDialog, RenameDialog } from './ManageDialogs'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Start playback, tolerating environments where play() returns nothing. */
function playAudio(el: HTMLAudioElement): void {
  const result = el.play() as Promise<void> | undefined
  if (result && typeof result.catch === 'function') result.catch(() => undefined)
}

const selectorValue = (value: string): string => value.replace(/["\\]/g, '\\$&')

/** Where to take the student when they open a lecture from search. */
export interface LectureFocus {
  atSec: number
  segmentId?: string
  /** The search, to highlight in the passage. */
  query?: string
  /** Changes on every request, so opening the same result twice still jumps. */
  nonce: number
}

interface Props {
  lecture: LectureRecord
  classes: ClassRecord[]
  progress: TranscriptionProgress | null
  /** What the transcription queue is doing; authoritative over a stale status. */
  queue?: TranscriptionQueueSnapshot | null
  /** Progress of the import creating this lecture, while it runs. */
  importProgress?: ImportProgress | null
  /** Jump to a moment on opening, e.g. from a search result. */
  focus?: LectureFocus | null
  playbackRate?: number
  onPlaybackRateChange?: (rate: number) => void
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
  focus,
  playbackRate,
  onPlaybackRateChange,
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
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [editing, setEditing] = useState<{ segmentId: string; draft: string } | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [flash, setFlash] = useState<{ segmentId: string; query: string; nonce: number } | null>(null)
  const [showOutline, setShowOutline] = useState(false)
  const [rate, setRate] = useState(() => normalizePlaybackRate(playbackRate ?? 1))
  const [exportFormat, setExportFormat] = useState<ExportFormat>('markdown')
  const audioRef = useRef<HTMLAudioElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const pendingSeekRef = useRef<number | null>(null)
  const onRateChangeRef = useRef(onPlaybackRateChange)
  onRateChangeRef.current = onPlaybackRateChange

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTranscript(await window.recture.transcript.get(lecture.id))
      setAudioUrl(await window.recture.transcript.audioUrl(lecture.id))
    } finally {
      setLoading(false)
    }
  }, [lecture.id])

  const loadBookmarks = useCallback(async () => {
    try {
      setBookmarks(await window.recture.bookmarks.list(lecture.id))
    } catch {
      setBookmarks([])
    }
  }, [lecture.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadBookmarks()
  }, [loadBookmarks])

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

  const paragraphs = useMemo(() => (transcript ? readableParagraphs(transcript, options) : []), [transcript, options])
  const pieces = useMemo(() => paragraphs.flatMap((p) => p.pieces), [paragraphs])
  /** Each segment's full wording, which is what a correction starts from. */
  const segmentsById = useMemo(() => {
    const source = transcript ? (options.applyAcceptedSuggestions ? materializeTranscript(transcript) : transcript) : null
    return new Map<string, TranscriptSegment>((source?.segments ?? []).map((s) => [s.id, s]))
  }, [transcript, options.applyAcceptedSuggestions])
  const matches = useMemo(
    () => (findOpen ? findMatches(pieces.map((p) => p.text), findQuery) : []),
    [findOpen, pieces, findQuery]
  )
  const activeIndex = matches.length > 0 ? Math.min(activeMatch, matches.length - 1) : -1
  const outline = useMemo(() => buildOutline(paragraphs, bookmarks), [paragraphs, bookmarks])
  const speakers = useMemo(() => (transcript ? speakersIn(transcript) : []), [transcript])
  const edits = transcript ? editedSegmentCount(transcript) : 0

  const pending = transcript?.suggestions.filter((s) => s.status === 'pending') ?? []

  const scrollToSegment = (segmentId: string): void => {
    const el = transcriptRef.current?.querySelector(`[data-seg="${selectorValue(segmentId)}"]`)
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }

  /** The passage being said at `seconds`. */
  const pieceAt = (seconds: number) => {
    let found = pieces[0] ?? null
    for (const piece of pieces) {
      if (piece.start <= seconds + 0.01) found = piece
      else break
    }
    return found
  }

  const seek = (seconds: number, play = true): void => {
    setPlayhead(seconds)
    const el = audioRef.current
    if (!el || el.readyState < 1) pendingSeekRef.current = seconds
    else el.currentTime = seconds
    if (el && play) playAudio(el)
  }

  const jumpTo = (seconds: number): void => {
    seek(seconds, false)
    const piece = pieceAt(seconds)
    if (piece) {
      setFlash({ segmentId: piece.segmentId, query: '', nonce: Date.now() })
      scrollToSegment(piece.segmentId)
    }
  }

  const changeRate = useCallback((next: number) => {
    const normalized = normalizePlaybackRate(next)
    setRate(normalized)
    if (audioRef.current) audioRef.current.playbackRate = normalized
    onRateChangeRef.current?.(normalized)
  }, [])

  const openFind = useCallback(() => {
    setFindOpen(true)
    setTimeout(() => findInputRef.current?.focus(), 0)
  }, [])

  const closeFind = (): void => {
    setFindOpen(false)
    setFindQuery('')
    setActiveMatch(0)
  }

  const stepMatch = (direction: 1 | -1): void => {
    if (matches.length === 0) return
    setActiveMatch((current) => (Math.min(current, matches.length - 1) + direction + matches.length) % matches.length)
  }

  // Opened from a search result: show the passage and have the audio ready there.
  const appliedFocusRef = useRef<number | null>(null)
  useEffect(() => {
    if (!focus || pieces.length === 0 || appliedFocusRef.current === focus.nonce) return
    appliedFocusRef.current = focus.nonce
    const target = pieces.find((p) => p.segmentId === focus.segmentId) ?? pieceAt(focus.atSec)
    if (target) setFlash({ segmentId: target.segmentId, query: focus.query ?? '', nonce: focus.nonce })
    seek(focus.atSec, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, pieces])

  useEffect(() => {
    if (flash) scrollToSegment(flash.segmentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flash])

  useEffect(() => {
    if (activeIndex < 0) return
    transcriptRef.current?.querySelector(`[data-match-index="${activeIndex}"]`)?.scrollIntoView?.({ block: 'center' })
  }, [activeIndex, findQuery])

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [rate, audioUrl])

  // Keyboard: find, and playback while reading.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        openFind()
        return
      }
      const target = event.target as HTMLElement | null
      const action = playbackKeyAction({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        targetTag: target?.tagName ?? null,
        targetEditable: Boolean(target?.isContentEditable)
      })
      const el = audioRef.current
      if (!action || !el) return
      event.preventDefault()
      if (action.type === 'toggle') {
        if (el.paused) playAudio(el)
        else el.pause()
      } else if (action.type === 'seek') {
        const end = Number.isFinite(el.duration) ? el.duration : Number.POSITIVE_INFINITY
        el.currentTime = Math.max(0, Math.min(end, el.currentTime + action.delta))
      } else {
        changeRate(stepPlaybackRate(el.playbackRate, action.direction))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [changeRate, openFind])

  const setSuggestion = async (suggestion: CorrectionSuggestion, status: 'accepted' | 'rejected'): Promise<void> => {
    try {
      setTranscript(await window.recture.transcript.setSuggestion(lecture.id, suggestion.id, status))
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  const exportLecture = async (destination: 'lecture-folder' | 'choose'): Promise<void> => {
    try {
      const saved = await window.recture.exports.lecture(lecture.id, exportFormat, options, destination)
      if (saved) onToast(`Saved ${saved}`)
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  const copyText = async (): Promise<void> => {
    try {
      const result = await window.recture.exports.clipboard(lecture.id, options)
      if (result.copied) onToast(`Copied ${result.length.toLocaleString()} characters.`)
      else {
        setSections(result.sections ?? [])
        onToast('This transcript is long — copy it in sections.')
      }
    } catch (err) {
      onToast(messageOf(err))
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
      onToast(messageOf(err))
    }
  }

  const cancelImport = async (): Promise<void> => {
    try {
      // The import removes the lecture it was creating; the parent navigates away.
      await window.recture.lectures.cancelImport(lecture.id)
      onChangedRef.current()
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  // --- corrections ---------------------------------------------------------------

  const startEdit = (segmentId: string): void => {
    if (inQueue) {
      onToast('This lecture is being transcribed again, which will replace the transcript. Edit it once that finishes.')
      return
    }
    setEditing({ segmentId, draft: segmentsById.get(segmentId)?.text ?? '' })
  }

  const saveEdit = async (): Promise<void> => {
    if (!editing) return
    try {
      setTranscript(await window.recture.transcript.editSegment(lecture.id, editing.segmentId, editing.draft))
      setEditing(null)
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  const revertEdit = async (segmentId: string): Promise<void> => {
    try {
      setTranscript(await window.recture.transcript.revertSegment(lecture.id, segmentId))
      setEditing(null)
      onToast('Restored the original wording.')
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  const renameSpeaker = async (speaker: string, name: string): Promise<void> => {
    if (name.trim() === (transcript?.speakerNames?.[speaker] ?? '')) return
    try {
      setTranscript(await window.recture.transcript.setSpeakerName(lecture.id, speaker, name))
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  // --- bookmarks -----------------------------------------------------------------

  const addBookmarkHere = async (): Promise<void> => {
    const at = audioRef.current?.currentTime ?? playhead
    try {
      setBookmarks(await window.recture.bookmarks.add(lecture.id, at, ''))
      onToast(`Bookmarked ${formatClock(at)}.`)
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  const saveBookmarkNote = async (bookmark: Bookmark, note: string): Promise<void> => {
    try {
      setBookmarks(await window.recture.bookmarks.update(lecture.id, bookmark.id, note))
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  const removeBookmark = async (bookmark: Bookmark): Promise<void> => {
    try {
      setBookmarks(await window.recture.bookmarks.remove(lecture.id, bookmark.id))
    } catch (err) {
      onToast(messageOf(err))
    }
  }

  let matchCounter = 0

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
        <select
          aria-label="Export format"
          value={exportFormat}
          onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
          disabled={!transcript}
          title={EXPORT_FORMATS[exportFormat].hint}
          style={{ width: 'auto' }}
        >
          {EXPORT_FORMAT_ORDER.map((format) => (
            <option key={format} value={format}>
              {EXPORT_FORMATS[format].label}
            </option>
          ))}
        </select>
        <button
          onClick={() => void exportLecture('lecture-folder')}
          disabled={!transcript}
          title="Save into this lecture’s folder"
        >
          Export
        </button>
        <button onClick={() => void exportLecture('choose')} disabled={!transcript}>
          Save as…
        </button>
        <button onClick={() => void copyText()} disabled={!transcript}>
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
              if (
                edits > 0 &&
                !window.confirm(
                  `Transcribing again replaces this transcript, including ${edits} passage${edits === 1 ? '' : 's'} you corrected by hand. Continue?`
                )
              ) {
                return
              }
              try {
                const result = await window.recture.transcript.retry(lecture.id)
                onToast(
                  result.position > 0
                    ? `Queued for transcription (#${result.position} in line).`
                    : 'Transcription started.'
                )
                onChanged()
              } catch (err) {
                onToast(messageOf(err))
              }
            }}
          >
            Retry transcription
          </button>
        )}
      </div>

      <div className="row wrap" style={{ marginBottom: 16, gap: 14 }}>
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
            checked={options.applyAcceptedSuggestions}
            onChange={(e) => setOptions({ ...options, applyAcceptedSuggestions: e.target.checked })}
          />
          Apply accepted corrections
        </label>
        <label className="check" title="Reads more smoothly. Turn off for the word-for-word record.">
          <input
            type="checkbox"
            checked={options.removeFillers}
            onChange={(e) => setOptions({ ...options, removeFillers: e.target.checked })}
          />
          Hide “um” and “uh”
        </label>
        {bookmarks.length > 0 && (
          <label className="check">
            <input
              type="checkbox"
              checked={options.includeBookmarks}
              onChange={(e) => setOptions({ ...options, includeBookmarks: e.target.checked })}
            />
            Bookmarks in exports
          </label>
        )}
      </div>

      {audioUrl && (
        <>
          <div className="row player">
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              style={{ flex: 1, minWidth: 0 }}
              onLoadedMetadata={(e) => {
                e.currentTarget.playbackRate = rate
                if (pendingSeekRef.current !== null) {
                  e.currentTarget.currentTime = pendingSeekRef.current
                  pendingSeekRef.current = null
                }
              }}
              onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
            />
            <select
              aria-label="Playback speed"
              value={rate}
              onChange={(e) => changeRate(Number(e.target.value))}
              style={{ width: 88 }}
            >
              {PLAYBACK_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </div>
          <div className="faint" style={{ marginBottom: 14 }}>
            Space play/pause · ← → 5 s · J L 15 s · [ ] speed · Ctrl+F find
          </div>
        </>
      )}

      {(audioUrl || bookmarks.length > 0) && (
        <div className="card">
          <div className="row" style={{ marginBottom: bookmarks.length > 0 ? 8 : 0 }}>
            <strong>Bookmarks</strong>
            {bookmarks.length > 0 && <span className="faint">{bookmarks.length}</span>}
            <div className="spacer" />
            {audioUrl && (
              <button onClick={() => void addBookmarkHere()} title="Bookmark the moment playing now">
                ★ Bookmark {formatClock(playhead)}
              </button>
            )}
          </div>
          {bookmarks.length === 0 ? (
            <div className="faint">Flag moments to come back to, while recording or here as you listen.</div>
          ) : (
            bookmarks.map((bookmark) => (
              <BookmarkRow
                key={`${bookmark.id}-${bookmark.note}`}
                bookmark={bookmark}
                onSeek={() => {
                  seek(bookmark.atSec)
                  const piece = pieceAt(bookmark.atSec)
                  if (piece) scrollToSegment(piece.segmentId)
                }}
                onSave={(note) => void saveBookmarkNote(bookmark, note)}
                onRemove={() => void removeBookmark(bookmark)}
              />
            ))
          )}
        </div>
      )}

      {transcript && speakers.length > 0 && (
        <details className="card speakers">
          <summary>
            <strong>Speakers</strong> <span className="faint">Name who is talking. Exports use these names.</span>
          </summary>
          <div className="stack" style={{ marginTop: 10 }}>
            {speakers.map((speaker) => (
              <SpeakerNameField
                key={`${speaker}-${transcript.speakerNames?.[speaker] ?? ''}`}
                speaker={speaker}
                name={transcript.speakerNames?.[speaker] ?? ''}
                disabled={inQueue}
                onSave={(name) => void renameSpeaker(speaker, name)}
              />
            ))}
          </div>
        </details>
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

      <div className="row transcript-header">
        <h2 style={{ margin: 0 }}>Transcript</h2>
        {edits > 0 && (
          <span className="chip" title="Passages you corrected by hand">
            {edits} edited
          </span>
        )}
        <div className="spacer" />
        {transcript && (
          <>
            <button className={showOutline ? 'ghost active' : 'ghost'} onClick={() => setShowOutline((v) => !v)}>
              Outline
            </button>
            <button className="ghost" onClick={openFind}>
              Find
            </button>
          </>
        )}
      </div>
      {transcript && !inQueue && (
        <div className="faint" style={{ marginBottom: 10 }}>
          Double-click any passage to correct it.
        </div>
      )}

      {showOutline && transcript && (
        <div className="card outline">
          {outline.length === 0 ? (
            <div className="faint">Nothing to outline yet.</div>
          ) : (
            outline.map((entry) => (
              <button key={entry.id} className={`outline-entry ${entry.kind}`} onClick={() => jumpTo(entry.atSec)}>
                <span className="mono faint outline-time">{formatClock(entry.atSec)}</span>
                <span>
                  {entry.kind === 'bookmark' ? '★ ' : ''}
                  {entry.label}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {findOpen && (
        <div className="row find-bar">
          <input
            ref={findInputRef}
            aria-label="Find in this lecture"
            placeholder="Find in this lecture"
            value={findQuery}
            onChange={(e) => {
              setFindQuery(e.target.value)
              setActiveMatch(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                stepMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                closeFind()
              }
            }}
          />
          <span className="faint find-count" aria-live="polite">
            {findQuery.trim().length < 2 ? '' : matches.length === 0 ? 'No matches' : `${activeIndex + 1} of ${matches.length}`}
          </span>
          <button onClick={() => stepMatch(-1)} disabled={matches.length === 0} aria-label="Previous match">
            ↑
          </button>
          <button onClick={() => stepMatch(1)} disabled={matches.length === 0} aria-label="Next match">
            ↓
          </button>
          <button className="ghost" onClick={closeFind} aria-label="Close find">
            ✕
          </button>
        </div>
      )}

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
        <div className="transcript" ref={transcriptRef}>
          {paragraphs.map((p, i) => {
            const playing = playhead >= p.start && playhead < p.end
            return (
              <div className={`para${playing ? ' playing' : ''}`} key={`${p.start}-${i}`}>
                <span className="para-time" onClick={() => seek(p.start)} title="Jump to this moment">
                  {formatClock(p.start)}
                </span>
                <span className="para-text">
                  {p.speaker && <strong className="speaker">{p.speaker}: </strong>}
                  {p.pieces.map((piece, k) => {
                    const separator = k < p.pieces.length - 1 ? ' ' : ''
                    if (editing?.segmentId === piece.segmentId) {
                      return (
                        <SegmentEditor
                          key={piece.segmentId}
                          draft={editing.draft}
                          edited={piece.edited}
                          onChange={(draft) => setEditing({ segmentId: piece.segmentId, draft })}
                          onSave={() => void saveEdit()}
                          onCancel={() => setEditing(null)}
                          onRevert={() => void revertEdit(piece.segmentId)}
                        />
                      )
                    }
                    const flashing = flash?.segmentId === piece.segmentId
                    const query = findOpen ? findQuery : flashing ? flash.query : ''
                    const className = ['seg', piece.edited ? 'edited' : '', flashing ? 'flash' : '']
                      .filter(Boolean)
                      .join(' ')
                    return (
                      <span
                        key={flashing ? `${piece.segmentId}-${flash.nonce}` : piece.segmentId}
                        data-seg={piece.segmentId}
                        className={className}
                        title={piece.edited ? 'You corrected this. Double-click to change it again.' : undefined}
                        onDoubleClick={() => startEdit(piece.segmentId)}
                      >
                        {highlightParts(piece.text, query).map((part, n) => {
                          if (!part.match) return <span key={n}>{part.text}</span>
                          const index = findOpen ? matchCounter++ : -1
                          return (
                            <mark
                              key={n}
                              className={index >= 0 && index === activeIndex ? 'find active' : 'find'}
                              data-match-index={index >= 0 ? index : undefined}
                            >
                              {part.text}
                            </mark>
                          )
                        })}
                        {separator}
                      </span>
                    )
                  })}
                </span>
              </div>
            )
          })}
        </div>
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
              onToast(messageOf(err))
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
              onToast(messageOf(err))
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
              onToast(messageOf(err))
            }
          }}
        />
      )}
    </div>
  )
}

/** Correcting one passage in place. Enter saves, Escape cancels. */
function SegmentEditor({
  draft,
  edited,
  onChange,
  onSave,
  onCancel,
  onRevert
}: {
  draft: string
  edited: boolean
  onChange: (draft: string) => void
  onSave: () => void
  onCancel: () => void
  onRevert: () => void
}): ReactNode {
  return (
    <span className="seg-editor">
      <textarea
        autoFocus
        aria-label="Correct this passage"
        value={draft}
        rows={Math.min(8, Math.max(2, Math.ceil(draft.length / 80)))}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSave()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <span className="row seg-editor-actions">
        <button className="primary" onClick={onSave}>
          Save
        </button>
        <button onClick={onCancel}>Cancel</button>
        {edited && (
          <button className="ghost" onClick={onRevert}>
            Restore original
          </button>
        )}
        <span className="faint">Enter to save · Esc to cancel</span>
      </span>
    </span>
  )
}

function BookmarkRow({
  bookmark,
  onSeek,
  onSave,
  onRemove
}: {
  bookmark: Bookmark
  onSeek: () => void
  onSave: (note: string) => void
  onRemove: () => void
}): ReactNode {
  const [note, setNote] = useState(bookmark.note)
  const at = formatClock(bookmark.atSec)
  return (
    <div className="bookmark-row">
      <button className="ghost mono" onClick={onSeek} title="Play from here">
        ★ {at}
      </button>
      <input
        value={note}
        placeholder="Add a note"
        aria-label={`Note for the bookmark at ${at}`}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note.trim() !== bookmark.note) onSave(note)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <button className="ghost" onClick={onRemove} aria-label={`Remove the bookmark at ${at}`}>
        ✕
      </button>
    </div>
  )
}

function SpeakerNameField({
  speaker,
  name,
  disabled,
  onSave
}: {
  speaker: string
  name: string
  disabled: boolean
  onSave: (name: string) => void
}): ReactNode {
  const [value, setValue] = useState(name)
  return (
    <div className="row">
      <span className="faint speaker-label">{speaker}</span>
      <input
        value={value}
        placeholder={speaker}
        disabled={disabled}
        aria-label={`Name for ${speaker}`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value.trim() !== name) onSave(value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
    </div>
  )
}
