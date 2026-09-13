import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AppSettings, ClassRecord, LectureRecord, SearchHit, ThemeSetting } from '@shared/types'
import { SearchResults } from './components/SearchResults'
import { useAppearance } from './hooks/useAppearance'
import { formatClock } from '@shared/naming'
import { useRecording } from './hooks/useRecording'
import { Empty, Modal, StatusChip, Toast, useElapsed } from './components/common'
import { RecordPanel } from './components/RecordPanel'
import { LectureView, type LectureFocus } from './components/LectureView'
import { GlossaryPanel } from './components/GlossaryPanel'
import { SettingsView } from './components/SettingsView'
import { DeleteDialog, RenameDialog } from './components/ManageDialogs'
import { ExportClassDialog } from './components/ExportDialogs'
import { useReadiness } from './hooks/useReadiness'
import { recordingAlerts, type AlertAction } from '@shared/alerts'
import { describeSkipped, partitionImportable } from '@shared/importFormats'
import { useImports } from './hooks/useImports'

type View =
  | { kind: 'class'; classId: string; tab: 'lectures' | 'glossary' }
  | { kind: 'lecture'; lectureId: string; focus?: LectureFocus }
  | { kind: 'settings' }
  | { kind: 'search' }

export default function App(): ReactNode {
  const [classes, setClasses] = useState<ClassRecord[]>([])
  const [lectures, setLectures] = useState<LectureRecord[]>([])
  const [view, setView] = useState<View>({ kind: 'settings' })
  const [toast, setToast] = useState<string | null>(null)
  const [creatingClass, setCreatingClass] = useState(false)
  const [className, setClassName] = useState('')
  const [query, setQuery] = useState('')
  const [renamingClass, setRenamingClass] = useState<ClassRecord | null>(null)
  const [deletingClass, setDeletingClass] = useState<ClassRecord | null>(null)
  const [exportingClass, setExportingClass] = useState<ClassRecord | null>(null)
  const [results, setResults] = useState<SearchHit[]>([])
  const [liveEnabled, setLiveEnabled] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [appearance, setAppearance] = useState<{ theme: ThemeSetting; fontSize: number; playbackRate: number }>({
    theme: 'system',
    fontSize: 15,
    playbackRate: 1
  })

  const applySettings = useCallback((settings: AppSettings) => {
    setLiveEnabled(settings.liveProvider === 'deepgram-live')
    setAppearance({
      theme: settings.theme,
      fontSize: settings.transcriptFontSize,
      playbackRate: settings.playbackRate
    })
  }, [])

  const notify = useCallback((message: string) => setToast(message), [])
  const recording = useRecording(notify)
  const elapsed = useElapsed(recording.state)
  const readiness = useReadiness(view.kind, recording.isRecording)
  const imports = useImports(notify)
  useAppearance(appearance.theme, appearance.fontSize)

  // Recomputed on every render. While recording, the elapsed clock re-renders
  // once a second, which keeps "no sound for N seconds" current.
  const alerts = recordingAlerts({
    recording: recording.isRecording,
    paused: recording.isPaused,
    nowMs: Date.now(),
    silence: recording.silence,
    micFellBack: recording.micFellBack,
    sleptDuringRecording: recording.sleptDuringRecording,
    disk: readiness.disk,
    battery: readiness.battery,
    readiness: readiness.issues
  })

  // The record panel lists every alert. Anywhere else, the sidebar surfaces
  // the one that cannot wait, so a dead microphone is noticed from any screen.
  const recordPanelVisible = view.kind === 'class' && view.tab === 'lectures'
  const sidebarAlert = recordPanelVisible
    ? null
    : alerts.find((a) => a.tone === 'danger' || a.id === 'mic-silent' || a.id === 'slept') ?? null

  const handleAlertAction = (action: AlertAction): void => {
    if (action === 'settings') setView({ kind: 'settings' })
    else if (action === 'reconnect') void recording.reconnect()
    else void recording.resume()
  }

  const refresh = useCallback(async () => {
    const [nextClasses, nextLectures, settings] = await Promise.all([
      window.recture.classes.list(),
      window.recture.lectures.all(),
      window.recture.settings.get()
    ])
    setClasses(nextClasses)
    setLectures(nextLectures)
    applySettings(settings)
    return nextClasses
  }, [applySettings])

  // Stable identity on purpose: LectureView reacts to transcription finishing,
  // and an inline arrow here gave it a new callback on every render.
  const handleLectureChanged = useCallback(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refresh().then((nextClasses) => {
      // Land somewhere useful: the first class, or settings on a fresh install.
      setView((current) =>
        current.kind === 'settings' && nextClasses[0]
          ? { kind: 'class', classId: nextClasses[0].id, tab: 'lectures' }
          : current
      )
    })
    const off = window.recture.events.onLibraryChanged((payload) => {
      void refresh()
      // The watcher reports folder changes made outside the app.
      const message = (payload as { message?: string } | null)?.message
      if (message) setToast(message)
    })
    return off
  }, [refresh])

  const activeClass = useMemo(() => {
    if (view.kind === 'class') return classes.find((c) => c.id === view.classId) ?? null
    if (view.kind === 'lecture') {
      const lecture = lectures.find((l) => l.id === view.lectureId)
      return lecture ? classes.find((c) => c.id === lecture.classId) ?? null : null
    }
    return null
  }, [view, classes, lectures])

  const classLectures = useCallback(
    (classId: string) => lectures.filter((l) => l.classId === classId),
    [lectures]
  )

  const startRecording = useCallback(
    async (classId: string, lectureId: string | null) => {
      await recording.start(classId, lectureId)
      await refresh()
    },
    [recording, refresh]
  )

  const stopRecording = useCallback(async () => {
    const lectureId = await recording.stop()
    await refresh()
    if (lectureId) setView({ kind: 'lecture', lectureId })
  }, [recording, refresh])

  /** Import files into a class: the given paths, or ones the student picks. */
  const importInto = useCallback(
    async (classId: string, paths?: string[]) => {
      try {
        const started = await window.recture.lectures.importAudio(classId, paths)
        await refresh()
        if (started.length === 1) setView({ kind: 'lecture', lectureId: started[0]!.id })
        else if (started.length > 1) {
          notify(`Importing ${started.length} files. Each is transcribed once it has been imported.`)
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh, notify]
  )

  // A file dropped outside a drop zone must do nothing at all.
  useEffect(() => {
    const block = (event: DragEvent): void => event.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  // The global hotkey routes here, because this window holds the microphone.
  useEffect(() => {
    return window.recture.events.onToggleRecord(() => {
      if (recording.isRecording) {
        void stopRecording()
        return
      }
      const target =
        (view.kind === 'class' && view.classId) ||
        (activeClass?.id ?? classes[0]?.id ?? null)
      if (!target) {
        notify('Create a class first, then record into it.')
        return
      }
      void startRecording(target, null)
    })
  }, [recording.isRecording, view, activeClass, classes, startRecording, stopRecording, notify])

  // One confirmation for every bookmark, whether from the button or the global
  // shortcut pressed in another app.
  useEffect(() => {
    return window.recture.events.onBookmarkAdded(({ bookmark }) => {
      notify(`Bookmarked ${formatClock(bookmark.atSec)}${bookmark.note ? ` — ${bookmark.note}` : ''}`)
    })
  }, [notify])

  useEffect(() => {
    if (view.kind !== 'search') return
    const timer = setTimeout(async () => {
      setResults(query.trim() ? await window.recture.lectures.search(query) : [])
    }, 200)
    return () => clearTimeout(timer)
  }, [query, view.kind])

  const createClass = async (): Promise<void> => {
    if (!className.trim()) return
    try {
      const created = await window.recture.classes.create({ name: className.trim() })
      setClassName('')
      setCreatingClass(false)
      await refresh()
      setView({ kind: 'class', classId: created.id, tab: 'lectures' })
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err))
    }
  }

  const activeLecture = view.kind === 'lecture' ? lectures.find((l) => l.id === view.lectureId) ?? null : null

  // A lecture or class can disappear while being viewed (deleted in Explorer).
  useEffect(() => {
    if (view.kind === 'lecture' && lectures.length > 0 && !activeLecture) {
      setView(classes[0] ? { kind: 'class', classId: classes[0].id, tab: 'lectures' } : { kind: 'settings' })
    }
    if (view.kind === 'class' && !classes.some((c) => c.id === view.classId)) {
      setView(classes[0] ? { kind: 'class', classId: classes[0].id, tab: 'lectures' } : { kind: 'settings' })
    }
  }, [view, classes, lectures, activeLecture])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="brand">Recture</span>
          <button className="ghost" onClick={() => setCreatingClass(true)} title="New class">
            ＋
          </button>
        </div>

        <div className="sidebar-scroll">
          <div className="section-label">Classes</div>
          {classes.length === 0 && <div className="faint" style={{ padding: '6px 9px' }}>No classes yet.</div>}
          {classes.map((klass) => (
            <button
              key={klass.id}
              className={`nav-item${view.kind === 'class' && view.classId === klass.id ? ' active' : ''}`}
              onClick={() => setView({ kind: 'class', classId: klass.id, tab: 'lectures' })}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{klass.name}</span>
              <span className="nav-count">{classLectures(klass.id).length}</span>
            </button>
          ))}

          <div className="section-label">Recent lectures</div>
          {lectures.slice(0, 8).map((lecture) => (
            <button
              key={lecture.id}
              className={`nav-item${view.kind === 'lecture' && view.lectureId === lecture.id ? ' active' : ''}`}
              onClick={() => setView({ kind: 'lecture', lectureId: lecture.id })}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {lecture.title}
              </span>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          {recording.isRecording && sidebarAlert && (
            <div className={`banner ${sidebarAlert.tone}`} style={{ fontSize: 12, margin: '0 0 8px' }} role="alert">
              {sidebarAlert.message}
            </div>
          )}
          {recording.isRecording && (
            <button className="danger" onClick={() => void stopRecording()}>
              ■ Stop ({formatClock(elapsed)}
              {recording.isPaused ? ' · paused' : ''})
            </button>
          )}
          <button
            className="nav-item"
            title="Re-read the lectures folder from disk"
            onClick={async () => {
              try {
                const report = await window.recture.library.rescan()
                await refresh()
                const changed =
                  report.classesAdopted + report.classesUpdated + report.classesRemoved +
                  report.lecturesAdopted + report.lecturesUpdated + report.lecturesRemoved
                notify(changed > 0 ? `Synced ${changed} change${changed === 1 ? '' : 's'} from disk.` : 'Library is already up to date.')
              } catch (err) {
                notify(err instanceof Error ? err.message : String(err))
              }
            }}
          >
            Sync with disk
          </button>
          <button className="nav-item" onClick={() => setView({ kind: 'search' })}>
            Search transcripts
          </button>
          <button className="nav-item" onClick={() => setView({ kind: 'settings' })}>
            Settings
          </button>
        </div>
      </aside>

      <main className="main">
        {view.kind === 'settings' && <SettingsView onToast={notify} onSettingsChanged={applySettings} />}

        {view.kind === 'search' && (
          <div className="main-inner">
            <h1>Search transcripts</h1>
            <p className="subtitle">Every transcribed lecture. Pick a result to open the lecture at that moment.</p>
            <input
              autoFocus
              placeholder="eigenvalue, midterm, office hours…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div style={{ marginTop: 16 }}>
              <SearchResults
                query={query}
                hits={results}
                classNames={Object.fromEntries(classes.map((c) => [c.id, c.name]))}
                onOpen={(request) =>
                  setView({
                    kind: 'lecture',
                    lectureId: request.lectureId,
                    focus:
                      request.atSec === undefined
                        ? undefined
                        : { atSec: request.atSec, segmentId: request.segmentId, query, nonce: Date.now() }
                  })
                }
              />
            </div>
          </div>
        )}

        {view.kind === 'class' && activeClass && (
          <div
            className="main-inner"
            style={dropping ? { outline: '2px dashed var(--ok)', outlineOffset: -8, borderRadius: 12 } : undefined}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              if (!dropping) setDropping(true)
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              setDropping(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDropping(false)
              const files = Array.from(e.dataTransfer.files).map((file) => ({
                name: file.name,
                path: window.recture.files.pathFor(file)
              }))
              const { accepted, skipped } = partitionImportable(files)
              const skippedNote = describeSkipped(skipped.map((f) => f.name))
              if (skippedNote) notify(skippedNote)
              if (accepted.length > 0) void importInto(activeClass.id, accepted.map((f) => f.path))
            }}
          >
            <div className="row" style={{ marginBottom: 4 }}>
              <h1 style={{ margin: 0 }}>{activeClass.name}</h1>
              <div className="spacer" />
              <button
                className={view.tab === 'lectures' ? 'primary' : undefined}
                onClick={() => setView({ ...view, tab: 'lectures' })}
              >
                Lectures
              </button>
              <button
                className={view.tab === 'glossary' ? 'primary' : undefined}
                onClick={() => setView({ ...view, tab: 'glossary' })}
              >
                Glossary
              </button>
              <button
                className="ghost"
                onClick={() => setExportingClass(activeClass)}
                title="Export every lecture in this class"
              >
                Export…
              </button>
              <button className="ghost" onClick={() => setRenamingClass(activeClass)} title="Rename class">
                Rename
              </button>
              <button className="ghost" onClick={() => setDeletingClass(activeClass)} title="Remove class">
                Remove
              </button>
            </div>
            <p className="subtitle">{activeClass.dirPath}</p>

            {view.tab === 'glossary' ? (
              <GlossaryPanel klass={activeClass} onToast={notify} />
            ) : (
              <>
                <RecordPanel
                  klass={activeClass}
                  lectures={classLectures(activeClass.id)}
                  state={recording.state}
                  level={recording.level}
                  liveLines={recording.liveLines}
                  starting={recording.starting}
                  cloudLiveEnabled={liveEnabled}
                  alerts={alerts}
                  onAlertAction={handleAlertAction}
                  onImport={() => void importInto(activeClass.id)}
                  onStart={(lectureId) => void startRecording(activeClass.id, lectureId)}
                  onStop={() => void stopRecording()}
                  onPause={() => void recording.pause()}
                  onResume={() => void recording.resume()}
                  onBookmark={(note) => void recording.bookmark(note)}
                  onNewLecture={async () => {
                    const created = await window.recture.lectures.create(activeClass.id, {})
                    await refresh()
                    setView({ kind: 'lecture', lectureId: created.id })
                  }}
                />

                <h2>Lectures</h2>
                {classLectures(activeClass.id).length === 0 ? (
                  <Empty title="No lectures yet" detail="Hit record when the professor starts." />
                ) : (
                  classLectures(activeClass.id).map((lecture) => (
                    <button
                      key={lecture.id}
                      className="lecture-row"
                      onClick={() => setView({ kind: 'lecture', lectureId: lecture.id })}
                    >
                      <div style={{ flex: 1 }}>
                        <div className="lecture-title">{lecture.title}</div>
                        <div className="faint">
                          {new Date(lecture.recordedAt).toLocaleDateString()} · {formatClock(lecture.durationSec)}
                        </div>
                      </div>
                      <StatusChip lecture={lecture} />
                    </button>
                  ))
                )}
              </>
            )}
          </div>
        )}

        {view.kind === 'lecture' &&
          (activeLecture ? (
            <LectureView
              key={activeLecture.id}
              lecture={activeLecture}
              classes={classes}
              progress={recording.progress}
              queue={recording.queue}
              importProgress={imports[activeLecture.id] ?? null}
              focus={view.focus ?? null}
              playbackRate={appearance.playbackRate}
              onPlaybackRateChange={(rate) => {
                setAppearance((current) => ({ ...current, playbackRate: rate }))
                void window.recture.settings.update({ playbackRate: rate }).catch(() => undefined)
              }}
              onToast={notify}
              onChanged={handleLectureChanged}
              onRemoved={() => {
                const parent = classes.find((c) => c.id === activeLecture.classId)
                void refresh()
                setView(parent ? { kind: 'class', classId: parent.id, tab: 'lectures' } : { kind: 'settings' })
              }}
            />
          ) : (
            <div className="main-inner">
              <Empty title="Lecture not found" detail="It may have been removed from the library." />
            </div>
          ))}
      </main>

      {creatingClass && (
        <Modal title="New class" onClose={() => setCreatingClass(false)}>
          <label htmlFor="class-name">Class name</label>
          <input
            id="class-name"
            autoFocus
            value={className}
            placeholder="CS 4501 Machine Learning"
            onChange={(e) => setClassName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void createClass()}
          />
          <p className="faint">A folder with this name is created in your lectures folder.</p>
          <div className="row">
            <div className="spacer" />
            <button onClick={() => setCreatingClass(false)}>Cancel</button>
            <button className="primary" onClick={() => void createClass()} disabled={!className.trim()}>
              Create
            </button>
          </div>
        </Modal>
      )}

      {renamingClass && (
        <RenameDialog
          title="Rename class"
          label="Class name"
          initial={renamingClass.name}
          hint="The folder on disk is renamed to match, and every lecture inside it moves with it."
          onClose={() => setRenamingClass(null)}
          onSubmit={async (name) => {
            const target = renamingClass
            setRenamingClass(null)
            try {
              await window.recture.classes.rename(target.id, name)
              await refresh()
              notify('Class renamed.')
            } catch (err) {
              notify(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      {exportingClass && (
        <ExportClassDialog
          className={exportingClass.name}
          lectureCount={classLectures(exportingClass.id).length}
          transcribedCount={classLectures(exportingClass.id).filter((l) => l.transcriptSource).length}
          onClose={() => setExportingClass(null)}
          onExport={async ({ format, layout, options }) => {
            const target = exportingClass
            setExportingClass(null)
            try {
              const result = await window.recture.exports.classLectures(target.id, format, options, layout)
              if (!result) return
              const skipped =
                result.skipped > 0
                  ? ` ${result.skipped} lecture${result.skipped === 1 ? '' : 's'} without a transcript ${result.skipped === 1 ? 'was' : 'were'} left out.`
                  : ''
              notify(`Exported ${result.exported} lecture${result.exported === 1 ? '' : 's'} to ${result.path}.${skipped}`)
            } catch (err) {
              notify(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      {deletingClass && (
        <DeleteDialog
          kind="class"
          name={deletingClass.name}
          folder={deletingClass.dirPath}
          lectureCount={classLectures(deletingClass.id).length}
          onClose={() => setDeletingClass(null)}
          onConfirm={async (deleteFiles) => {
            const target = deletingClass
            setDeletingClass(null)
            try {
              const result = await window.recture.classes.remove(target.id, deleteFiles)
              const remaining = await refresh()
              setView(
                remaining[0] ? { kind: 'class', classId: remaining[0].id, tab: 'lectures' } : { kind: 'settings' }
              )
              notify(
                result.filesDeleted
                  ? `Deleted ${target.name} and its recordings.`
                  : `Removed ${target.name} from the library. The files are still in ${result.folder}.`
              )
            } catch (err) {
              notify(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      )}

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  )
}
