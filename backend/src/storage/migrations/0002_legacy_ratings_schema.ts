/**
 * Version 1 to 2: the pending forward migration for deployed application databases.
 *
 * Append every version 2 schema update here until the project owner directs another version bump.
 * Each step must be safe to retry because SQLite runs migrations outside a transaction. This file
 * becomes immutable when the next version is created.
 */
import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

import type { Database } from '../schema.js'

/** Build the version 2 ratings indexes without depending on the mutable flat schema. */
async function createVersionTwoRatingsIndexes(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createIndex('ratings_season_agent')
    .on('ratings')
    .columns(['season_id', 'agent_kind', 'agent_builtin_name', 'agent_submission_id'])
    .execute()
  await db.schema
    .createIndex('ratings_env_agent_user')
    .on('ratings')
    .columns(['env_id', 'agent_user_id'])
    .execute()
  await sql`
    CREATE UNIQUE INDEX ratings_one_per_user_submission
    ON ratings (season_id, rater_user_id, agent_kind, agent_submission_id)
    WHERE agent_kind = 'submission'
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX ratings_one_per_user_builtin
    ON ratings (season_id, rater_user_id, agent_kind, agent_builtin_name)
    WHERE agent_kind = 'builtin'
  `.execute(db)
}

/** Add the required rating comment and named-builtin identity to the legacy rating table. */
export const legacyRatingsSchema: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db)
    if (version.rows[0]?.user_version !== 0) {
      return
    }

    const columns = new Set(
      (await sql<{ name: string }>`PRAGMA table_info(ratings)`.execute(db)).rows.map(
        (column) => column.name,
      ),
    )
    if (!columns.has('agent_builtin_name')) {
      await db.schema.alterTable('ratings').addColumn('agent_builtin_name', 'text').execute()
    }
    if (!columns.has('feedback')) {
      await db.schema
        .alterTable('ratings')
        .addColumn('feedback', 'text', (column) => column.notNull().defaultTo(''))
        .execute()
    }

    // The former schema had one hard-coded builtin identity. Preserve those rows under the current
    // named-builtin representation before replacing its partial uniqueness index.
    await sql`
      UPDATE ratings
      SET agent_kind = 'builtin', agent_builtin_name = 'naive'
      WHERE agent_kind = 'builtin-naive'
    `.execute(db)

    for (const index of [
      'ratings_season_agent',
      'ratings_env_agent_user',
      'ratings_one_per_user_agent',
      'ratings_one_per_user_naive',
      'ratings_one_per_user_submission',
      'ratings_one_per_user_builtin',
    ]) {
      await sql.raw(`DROP INDEX IF EXISTS ${index}`).execute(db)
    }
    await createVersionTwoRatingsIndexes(db)

    // A deployed version 1 database predates the marker and reads 0. A fresh database is already
    // stamped by 0001 and returns at the guard above. Stamp only after every retry-safe step succeeds.
    await sql.raw('PRAGMA user_version = 2').execute(db)
  },

  async down(): Promise<void> {
    // Nothing to undo on its own: the flat migration's down drops the whole ratings table. The
    // empty function still matters, since Kysely skips a migration without a down during rollback
    // and leaves its ledger row behind, which corrupts the migration order for the next run.
  },
}
