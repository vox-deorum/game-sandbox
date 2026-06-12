/**
 * The live session page. This infrastructure step provides the route and a placeholder; the
 * live-session-control step replaces it with the renderer host over the live socket, the human-slot
 * timeout control, pause/resume, and the end-of-session card.
 */
import type { ReactNode } from 'react'
import { useParams } from 'react-router'

export function SessionPage(): ReactNode {
  const { id } = useParams<{ id: string }>()
  return (
    <section>
      <h1>Session</h1>
      <p className="status">
        The live play host for session <code>{id}</code> lands in the live-session step.
      </p>
    </section>
  )
}
