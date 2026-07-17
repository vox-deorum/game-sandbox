/**
 * Session-lifecycle queries: create a session, advance it through `starting` → `running` →
 * `ended`, and the reads that back the one-active-session-per-user rule and the admin listing.
 */
import type { Kysely } from 'kysely'

import type { NewSessionInput } from '../index.js'
import type { Database, Session, TerminationReason } from '../schema.js'

/** The non-terminal session statuses that count as "active" for the one-per-user rule. */
const ACTIVE_STATUSES = ['starting', 'running'] as const

export async function createSession(
  db: Kysely<Database>,
  input: NewSessionInput,
): Promise<Session> {
  return await db
    .insertInto('sessions')
    .values({
      ...input,
      season_id: input.season_id ?? null,
      human_timeout_ms: input.human_timeout_ms ?? null,
      messaging_enabled: input.messaging_enabled ?? 0,
      message_cap: input.message_cap ?? null,
      llm_enabled: input.llm_enabled ?? 0,
      status: 'starting',
      termination_reason: null,
      ended_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
}

export async function markRunning(db: Kysely<Database>, id: string): Promise<void> {
  await db.updateTable('sessions').set({ status: 'running' }).where('id', '=', id).execute()
}

export async function markEnded(
  db: Kysely<Database>,
  id: string,
  reason: TerminationReason,
  endedAt: string,
): Promise<void> {
  await db
    .updateTable('sessions')
    .set({ status: 'ended', termination_reason: reason, ended_at: endedAt })
    .where('id', '=', id)
    .execute()
}

export async function findActiveSessionByUser(
  db: Kysely<Database>,
  userId: string,
): Promise<Session | undefined> {
  return await db
    .selectFrom('sessions')
    .selectAll()
    .where('user_id', '=', userId)
    .where('status', 'in', ACTIVE_STATUSES)
    .executeTakeFirst()
}

export async function getSession(db: Kysely<Database>, id: string): Promise<Session | undefined> {
  return await db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst()
}

export async function listSessions(db: Kysely<Database>): Promise<Session[]> {
  return await db.selectFrom('sessions').selectAll().orderBy('created_at', 'desc').execute()
}
