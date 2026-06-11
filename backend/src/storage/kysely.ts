/**
 * The one implementation of {@link Storage}, written against Kysely's dialect-agnostic query
 * API. Because the domain types are the row types, there is no row-mapping layer: queries
 * return {@link Session} directly.
 */
import type { Kysely } from 'kysely'

import type { NewSessionInput, Storage } from './index.js'
import type { Database, Session, TerminationReason } from './schema.js'

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

  async close(): Promise<void> {
    await this.db.destroy()
  }
}
