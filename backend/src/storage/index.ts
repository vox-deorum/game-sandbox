/**
 * The storage seam.
 *
 * A narrow, domain-shaped interface over the relational data: callers see the derived domain
 * types from `schema.ts`, never SQL or query building. This interface is what the orchestrator
 * and the HTTP tests are written against; `kysely.ts` is its one implementation and `sqlite.ts`
 * its one wiring today. Swapping engines is a new wiring file against the same schema, queries,
 * and interface.
 */
import type { Session, SessionMode, TerminationReason } from './schema.js'

export type { Session, SessionMode, SessionStatus, TerminationReason } from './schema.js'

/** The fields the orchestrator provides when starting a session. */
export interface NewSessionInput {
  id: string
  user_id: string
  env_id: string
  mode: SessionMode
  recording_id: string | null
  created_at: string
}

export interface Storage {
  /** Insert a new session as `starting` and return the stored row. */
  createSession(input: NewSessionInput): Promise<Session>
  /** Move a session to `running` (the container's header line has arrived). */
  markRunning(id: string): Promise<void>
  /** Finalize a session: `ended`, with its reason and end timestamp. Idempotent at the SQL
   * level (it simply writes the columns), so the orchestrator's finalize can call it freely. */
  markEnded(id: string, reason: TerminationReason, endedAt: string): Promise<void>
  /** The user's active (`starting` or `running`) session, if any; backs the one-per-user rule. */
  findActiveSessionByUser(userId: string): Promise<Session | undefined>
  /** One session by id. */
  getSession(id: string): Promise<Session | undefined>
  /** All sessions, most recent first. */
  listSessions(): Promise<Session[]>
  /** Release the underlying database handle. */
  close(): Promise<void>
}
