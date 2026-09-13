import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ClassRecord, LectureRecord } from '@shared/types'
import { formatClock } from '@shared/naming'
import { useRecording } from './hooks/useRecording'
import { Empty, Modal, StatusChip, Toast, useElapsed } from './components/common'
import { RecordPanel } from './components/RecordPanel'
import { LectureView } from './components/LectureView'
import { GlossaryPanel } from './components/GlossaryPanel'
import { SettingsView } from './components/SettingsView'
import { DeleteDialog, RenameDialog } from './components/ManageDialogs'

type View =
  | { kind: 'class'; classId: string; tab: 'lectures' | 'glossary' }
  | { kind: 'lecture'; lectureId: string }
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
  const [results, setResults] = useState<{ lecture: LectureRecord; snippet: string }[]>([])
  const [liveEnabled, setLiveEnabled] = useState(false)

  const notify = useCallback((message: string) => setToast(message), [])
  const recording = useRecording(notify)
  const elapsed = useElapsed(recording.state?.startedAt ?? null, recording.isRecording)

  const refresh = useCallback(async () => {
    const [nextClasses, nextLectures, settings] = await Promise.all([
      window.recture.classes.list(),
      window.recture.lectures.all(),
      window.recture.settings.get()
    ])
    setClasses(nextClasses)
    setLectures(nextLectures)
    setLiveEnabled(settings.liveProvider === 'deepgram-live')
    return nextClasses
  }, [])

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
          {recording.isRecording && (
            <button className="danger" onClick={() => void stopRecording()}>
              ■ Stop ({formatClock(elapsed)})
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
        {view.kind === 'settings' && <SettingsView onToast={notify} />}

        {view.kind === 'search' && (
          <div className="main-inner">
            <h1>Search transcripts</h1>
            <p className="subtitle">Full-text search across every completed lecture.</p>
            <input
              autoFocus
              placeholder="eigenvalue, midterm, office hours…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div style={{ marginTop: 16 }}>
              {query.trim() && results.length === 0 && <Empty title="No matches" />}
              {results.map(({ lecture, snippet }) => (
                <button
                  key={lecture.id}
                  className="lecture-row"
                  onClick={() => setView({ kind: 'lecture', lectureId: lecture.id })}
                >
                  <div style={{ flex: 1 }}>
                    <div className="lecture-title">{lecture.title}</div>
                    <div
                      className="faint"
                      dangerouslySetInnerHTML={{
                        // Snippet markers come from SQLite's own snippet(), not
                        // from user input.
                        __html: snippet.replace(/\[/g, '<mark>').replace(/\]/g, '</mark>')
                      }}
                    />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {view.kind === 'class' && activeClass && (
          <div className="main-inner">
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
                  onStart={(lectureId) => void startRecording(activeClass.id, lectureId)}
                  onStop={() => void stopRecording()}
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
