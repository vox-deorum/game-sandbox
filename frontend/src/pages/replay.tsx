/**
 * The replay viewer page. This infrastructure step provides the route and a placeholder; the
 * replay-and-retention step replaces it with the viewer (load by URL, play, pause, step, scrub) over
 * the same renderer the live host uses.
 */
import type { ReactNode } from 'react'
import { useParams } from 'react-router'

export function ReplayPage(): ReactNode {
  const { id } = useParams<{ id: string }>()
  return (
    <section>
      <h1>Replay</h1>
      <p className="status">
        The replay viewer for recording <code>{id}</code> lands in the replay step.
      </p>
    </section>
  )
}
