/**
 * Environment page: the description, the entry points into play and watch (gated by the allowlist),
 * and the recent-replays list.
 *
 * The play and watch entry points are hidden when `/api/me` says the user is not allowlisted, and the
 * backend enforces the same gate, so the UI state is courtesy and the backend check is the
 * enforcement. Starting a session here is the seam the live-session step builds the full host on: it
 * resolves to a session id this page navigates to, and the already-active case offers rejoin by
 * navigating to the user's existing session instead of dead-ending. The per-step timeout override and
 * the in-session controls (pause, the active-timeout display) live on the session page.
 *
 * Leaderboards and the submission form join in Stages 5 and 6; the page renders without them rather
 * than carrying placeholders.
 */
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import {
  getEnvironments,
  listRecordings,
  type RecordingSummary,
  startSession,
} from '../api/client.js'
import { useMe } from '../me.js'

function RecentReplays({ envId }: { envId: string }): ReactNode {
  const [replays, setReplays] = useState<RecordingSummary[] | null>(null)

  useEffect(() => {
    let active = true
    listRecordings({ env: envId }).then(
      (all) => {
        if (active) {
          setReplays(all.filter((r) => r.header.environment === envId))
        }
      },
      () => {
        if (active) {
          setReplays([])
        }
      },
    )
    return () => {
      active = false
    }
  }, [envId])

  if (replays === null) {
    return <p className="status">Loading replays…</p>
  }
  if (replays.length === 0) {
    return <p className="status">No replays yet.</p>
  }
  return (
    <ul className="replay-list">
      {replays.map((replay) => (
        <li key={replay.id}>
          <Link to={`/replays/${replay.id}`}>{replay.id}</Link>
        </li>
      ))}
    </ul>
  )
}

export function EnvironmentPage(): ReactNode {
  const { envId } = useParams<{ envId: string }>()
  const navigate = useNavigate()
  const { me } = useMe()
  const [meta, setMeta] = useState<EnvironmentMeta | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    getEnvironments().then(
      (envs) => {
        if (!active) {
          return
        }
        const found = envs.find((e) => e.env_id === envId)
        if (found === undefined) {
          setNotFound(true)
        } else {
          setMeta(found)
        }
      },
      () => {
        if (active) {
          setNotFound(true)
        }
      },
    )
    return () => {
      active = false
    }
  }, [envId])

  async function start(mode: 'human' | 'scripted'): Promise<void> {
    if (meta === null) {
      return
    }
    setStartError(null)
    const result = await startSession({ envId: meta.env_id, mode })
    if (result.ok) {
      navigate(`/sessions/${result.session.id}`)
    } else if (result.reason === 'already_active') {
      // Rejoin rather than dead-end: the user already has a session running.
      navigate(`/sessions/${result.activeSessionId}`)
    } else if (result.reason === 'not_allowlisted') {
      setStartError('You are not on the session allowlist.')
    } else {
      setStartError(result.message)
    }
  }

  if (notFound) {
    return <p className="status">No such environment.</p>
  }
  if (meta === null) {
    return <p className="status">Loading…</p>
  }

  const allowlisted = me?.allowlisted ?? false
  const humanPlayable = meta.human_slots.length > 0

  return (
    <section>
      <h1>{meta.display_name}</h1>
      <p className="env-description">{meta.description}</p>

      {allowlisted ? (
        <div className="entry-points">
          {humanPlayable ? (
            <button type="button" onClick={() => void start('human')}>
              Play
            </button>
          ) : null}
          <button type="button" onClick={() => void start('scripted')}>
            Watch
          </button>
        </div>
      ) : (
        <p className="status">Live play is limited to allowlisted users.</p>
      )}
      {startError !== null ? <p className="error">{startError}</p> : null}

      <h2>Recent replays</h2>
      <RecentReplays envId={meta.env_id} />
    </section>
  )
}
