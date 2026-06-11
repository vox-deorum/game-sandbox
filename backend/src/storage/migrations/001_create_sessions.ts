/**
 * The first migration: the `sessions` table and an index for the one-active-session-per-user
 * lookup. Migrations are ordered TypeScript modules run on startup through Kysely's `Migrator`;
 * there is no migration CLI, deployment is "start the process".
 */
import type { Kysely } from 'kysely'
import type { Migration } from 'kysely/migration'

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('sessions')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('mode', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('termination_reason', 'text')
      .addColumn('recording_id', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('ended_at', 'text')
      .execute()

    await db.schema
      .createIndex('sessions_user_status')
      .on('sessions')
      .columns(['user_id', 'status'])
      .execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('sessions_user_status').execute()
    await db.schema.dropTable('sessions').execute()
  },
}
