/**
 * The one implementation of {@link Storage}, written against Kysely's dialect-agnostic query
 * API. Because the domain types are the row types, there is no row-mapping layer: queries
 * return {@link Session} directly.
 */
import type { Kysely } from 'kysely'

import type { NewRecordingInput, NewSessionInput, Storage } from './index.js'
import type { Database, Recording, Session, TerminationReason } from './schema.js'

const ACTIVE_STATUSES = ['starting', 'running'] as const

export class KyselyStorage implements Storage {
  constructor(private readonly db: Kysely<Database>) {}

  async createSession(input: NewSessionInput): Promise<Session> {
    return await this.db
      .insertInto('sessions')
      .values({
        ...input,
        status: 'starting',
        termination_reason: null,
        ended_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  async markRunning(id: string): Promise<void> {
    await this.db.updateTable('sessions').set({ status: 'running' }).where('id', '=', id).execute()
  }

  async markEnded(id: string, reason: TerminationReason, endedAt: string): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ status: 'ended', termination_reason: reason, ended_at: endedAt })
      .where('id', '=', id)
      .execute()
  }

  async findActiveSessionByUser(userId: string): Promise<Session | undefined> {
    return await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .where('status', 'in', ACTIVE_STATUSES)
      .executeTakeFirst()
  }

  async getSession(id: string): Promise<Session | undefined> {
    return await this.db.selectFrom('sessions').selectAll().where('id', '=', id).executeTakeFirst()
  }

  async listSessions(): Promise<Session[]> {
    return await this.db.selectFrom('sessions').selectAll().orderBy('created_at', 'desc').execute()
  }

  async createRecording(input: NewRecordingInput): Promise<void> {
    // Idempotent: a re-finalize (or a backfilled id) leaves the existing row untouched.
    await this.db
      .insertInto('recordings')
      .values({ ...input, pinned: 0 })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute()
  }

  async listRecordings(): Promise<Recording[]> {
    return await this.db
      .selectFrom('recordings')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute()
  }

  async getRecording(id: string): Promise<Recording | undefined> {
    return await this.db
      .selectFrom('recordings')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
  }

  async setRecordingPinned(id: string, pinned: boolean): Promise<void> {
    await this.db
      .updateTable('recordings')
      .set({ pinned: pinned ? 1 : 0 })
      .where('id', '=', id)
      .execute()
  }

  async countPinnedByUser(userId: string): Promise<number> {
    const row = await this.db
      .selectFrom('recordings')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('user_id', '=', userId)
      .where('pinned', '=', 1)
      .executeTakeFirst()
    return Number(row?.count ?? 0)
  }

  async deleteRecording(id: string): Promise<void> {
    await this.db.deleteFrom('recordings').where('id', '=', id).execute()
  }

  async close(): Promise<void> {
    await this.db.destroy()
  }
}
