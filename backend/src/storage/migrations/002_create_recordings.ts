/**
 * The second migration: the `recordings` retention table and a backfill from `sessions`.
 *
 * Retention needs an owner and an age per recording, which Stage 3 did not track. This table is
 * that metadata; the directory on the volume stays the recording itself. The backfill turns every
 * pre-Stage-4 session row carrying a `recording_id` into a recordings row, so existing recordings
 * join the policy instead of becoming rowless debris. The `user_id`/`created_at` index backs the
 * per-user quota sweep.
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('recordings')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('pinned', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()

    await db.schema
      .createIndex('recordings_user_created')
      .on('recordings')
      .columns(['user_id', 'created_at'])
      .execute()

    // Backfill one row per existing session that produced a recording, so pre-Stage-4 recordings
    // are governed by retention rather than ignored. Unpinned by default.
    await sql`
      INSERT INTO recordings (id, user_id, env_id, created_at, pinned)
      SELECT recording_id, user_id, env_id, created_at, 0
      FROM sessions
      WHERE recording_id IS NOT NULL
    `.execute(db)
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('recordings_user_created').execute()
    await db.schema.dropTable('recordings').execute()
  },
}
