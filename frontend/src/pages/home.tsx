/**
 * Home: every environment as a card driven by the public metadata from `GET /api/environments`.
 *
 * Each card shows the display name, the short description, the slot count from min/max, a
 * human-playable badge from `human_slots`, and the registry thumbnail, exactly the card fields the
 * frontend spec names. The thumbnail comes from the registered renderer module, with a placeholder
 * for an environment whose renderer is not registered yet.
 */
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router'

import { getEnvironments } from '../api/client.js'
import { thumbnailFor } from '../renderers/registry.js'

function slotLabel(meta: EnvironmentMeta): string {
  return meta.min_slots === meta.max_slots
    ? `${meta.min_slots} ${meta.min_slots === 1 ? 'slot' : 'slots'}`
    : `${meta.min_slots}–${meta.max_slots} slots`
}

function EnvironmentCard({ meta }: { meta: EnvironmentMeta }): ReactNode {
  const humanPlayable = meta.human_slots.length > 0
  return (
    <Link className="card" to={`/environments/${meta.env_id}`}>
      <img className="card-thumb" src={thumbnailFor(meta.renderer)} alt="" />
      <div className="card-body">
        <h2 className="card-title">{meta.display_name}</h2>
        <p className="card-description">{meta.description}</p>
        <div className="card-meta">
          <span className="badge">{slotLabel(meta)}</span>
          {humanPlayable ? <span className="badge badge-human">Human playable</span> : null}
        </div>
      </div>
    </Link>
  )
}

export function HomePage(): ReactNode {
  const [environments, setEnvironments] = useState<EnvironmentMeta[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    getEnvironments().then(
      (envs) => {
        if (active) {
          setEnvironments(envs)
        }
      },
      () => {
        if (active) {
          setError(true)
        }
      },
    )
    return () => {
      active = false
    }
  }, [])

  if (error) {
    return <p className="status">Could not load environments.</p>
  }
  if (environments === null) {
    return <p className="status">Loading environments…</p>
  }
  return (
    <section>
      <h1>Environments</h1>
      <div className="card-grid">
        {environments.map((meta) => (
          <EnvironmentCard key={meta.env_id} meta={meta} />
        ))}
      </div>
    </section>
  )
}
