/**
 * Version 2 to 3: the pending forward migration for deployed application databases.
 *
 * Append every version 3 schema update here until the project owner directs another version bump.
 * Each step must be safe to retry because SQLite runs migrations outside a transaction. This file
 * becomes immutable when the next version is created.
 */
import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

import type { Database } from '../schema.js'

/**
 * Add the optional template repository branch to every season, plus the flag that records an
 * operator's saved template repository so the season seed never overwrites it.
 */
export const seasonTemplateBranch: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    const version = await sql<{ user_version: number }>`PRAGMA user_version`.execute(db)
    if (version.rows[0]?.user_version !== 2) {
      return
    }

    const columns = new Set(
      (await sql<{ name: string }>`PRAGMA table_info(seasons)`.execute(db)).rows.map(
        (column) => column.name,
      ),
    )
    if (!columns.has('template_repo_branch')) {
      await db.schema.alterTable('seasons').addColumn('template_repo_branch', 'text').execute()
    }
    if (!columns.has('template_repo_operator_owned')) {
      await db.schema
        .alterTable('seasons')
        .addColumn('template_repo_operator_owned', 'integer', (col) => col.notNull().defaultTo(0))
        .execute()
    }
    // Before version 3 only operators could set a template repository, so a saved URL is theirs.
    await db
      .updateTable('seasons')
      .set({ template_repo_operator_owned: 1 })
      .where('template_repo_url', 'is not', null)
      .execute()

    // A version 2 database, including one 0002 just upgraded, reads 2 here. A fresh database is
    // already stamped by 0001 and returns at the guard above. Stamp only after every step succeeds.
    await sql.raw('PRAGMA user_version = 3').execute(db)
  },

  async down(): Promise<void> {
    // Nothing to undo on its own: the flat migration's down drops the whole seasons table. The
    // empty function still matters, since Kysely skips a migration without a down during rollback
    // and leaves its ledger row behind, which corrupts the migration order for the next run.
  },
}
