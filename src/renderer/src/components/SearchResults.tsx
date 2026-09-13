import type { ReactNode } from 'react'
import type { SearchHit } from '@shared/types'
import { formatClock } from '@shared/naming'
import { snippetParts } from '@shared/reading'
import { Empty } from './common'

export interface SearchOpenRequest {
  lectureId: string
  /** The moment to jump to; absent to open the lecture at the top. */
  atSec?: number
  segmentId?: string
}

/** A search snippet with its matches marked. Transcript text is only ever rendered as text. */
export function Snippet({ text }: { text: string }): ReactNode {
  return (
    <>
      {snippetParts(text).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
    </>
  )
}

export function SearchResults({
  query,
  hits,
  classNames,
  onOpen
}: {
  query: string
  hits: SearchHit[]
  classNames: Record<string, string>
  onOpen: (request: SearchOpenRequest) => void
}): ReactNode {
  if (!query.trim()) return null
  if (hits.length === 0) return <Empty title="No matches" detail="Try fewer or different words." />

  return (
    <div>
      {hits.map((hit) => (
        <div key={hit.lecture.id} className="card search-hit">
          <button className="search-hit-title" onClick={() => onOpen({ lectureId: hit.lecture.id })}>
            <span className="lecture-title">{hit.lecture.title}</span>
            <span className="faint">
              {classNames[hit.lecture.classId] ?? ''} · {new Date(hit.lecture.recordedAt).toLocaleDateString()}
            </span>
          </button>
          {hit.matches.length === 0 ? (
            <div className="faint">
              <Snippet text={hit.snippet} />
            </div>
          ) : (
            hit.matches.map((match) => (
              <button
                key={match.segmentId}
                className="search-moment"
                title="Open the lecture at this moment"
                onClick={() => onOpen({ lectureId: hit.lecture.id, atSec: match.startSec, segmentId: match.segmentId })}
              >
                <span className="mono faint search-moment-time">{formatClock(match.startSec)}</span>
                <span>
                  <Snippet text={match.snippet} />
                </span>
              </button>
            ))
          )}
        </div>
      ))}
    </div>
  )
}
