import { useEffect, useState, type ReactNode } from 'react'
import type { ClassRecord, GlossaryTerm } from '@shared/types'
import { Empty, Modal } from './common'

/**
 * Per-class glossary. These terms are sent to the STT provider as keyterm
 * hints on every request for this class, and are the only vocabulary the
 * post-transcription correction step is allowed to propose.
 */
export function GlossaryPanel({ klass, onToast }: { klass: ClassRecord; onToast: (m: string) => void }): ReactNode {
  const [terms, setTerms] = useState<GlossaryTerm[]>([])
  const [term, setTerm] = useState('')
  const [note, setNote] = useState('')
  const [importing, setImporting] = useState(false)
  const [bulk, setBulk] = useState('')

  const reload = async (): Promise<void> => setTerms(await window.lecturerec.glossary.list(klass.id))

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [klass.id])

  const add = async (): Promise<void> => {
    if (!term.trim()) return
    try {
      await window.lecturerec.glossary.add(klass.id, term.trim(), note.trim() || null)
      setTerm('')
      setNote('')
      await reload()
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Glossary</h2>
        <span className="chip">{terms.length}</span>
        <div className="spacer" />
        <button onClick={() => setImporting(true)}>Import list…</button>
      </div>
      <p className="faint" style={{ marginTop: -4, marginBottom: 12 }}>
        Course terms, the professor’s name, textbook vocabulary. These are sent to the transcription model as hints,
        and are the only words the review step will ever suggest.
      </p>

      <div className="card">
        <div className="grid-2" style={{ marginBottom: 10 }}>
          <div>
            <label htmlFor="term">Term</label>
            <input
              id="term"
              value={term}
              placeholder="eigenvalue"
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
          </div>
          <div>
            <label htmlFor="note">Note (optional)</label>
            <input
              id="note"
              value={note}
              placeholder="linear algebra"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void add()}
            />
          </div>
        </div>
        <button className="primary" onClick={() => void add()} disabled={!term.trim()}>
          Add term
        </button>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {terms.length === 0 ? (
          <Empty title="No terms yet" detail="Add the vocabulary this class actually uses." />
        ) : (
          terms.map((t) => (
            <div className="term-row" key={t.id}>
              <span className="term-name">{t.term}</span>
              {t.note && <span className="faint">{t.note}</span>}
              <div className="spacer" />
              <button
                className="ghost"
                onClick={async () => {
                  await window.lecturerec.glossary.remove(klass.id, t.id)
                  await reload()
                }}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      {importing && (
        <Modal title="Import glossary" onClose={() => setImporting(false)}>
          <p className="faint" style={{ marginTop: 0 }}>
            One term per line. Add an optional note after <code>::</code>.
          </p>
          <textarea
            rows={10}
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            placeholder={'eigenvalue\nstochastic gradient descent :: week 4\nDr. Chakrabarti :: instructor'}
          />
          <div className="row" style={{ marginTop: 12 }}>
            <div className="spacer" />
            <button onClick={() => setImporting(false)}>Cancel</button>
            <button
              className="primary"
              onClick={async () => {
                await window.lecturerec.glossary.importText(klass.id, bulk)
                setBulk('')
                setImporting(false)
                await reload()
                onToast('Glossary imported.')
              }}
            >
              Import
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
