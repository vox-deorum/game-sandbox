/**
 * The fourth migration: Stage 6 grows the `iterations` row into full per-iteration configuration and
 * adds the leaderboard tables (runs, scheduled games, per-seat results, placements, ratings, and the
 * agent-author rating prompts).
 *
 * It is additive over the Stage 3/4/5 migrations and rewrites no existing rows beyond back-filling the
 * new defaulted columns. The Stage 5 `status` column is renamed to `submission_status`; the
 * open-submission partial unique index is recreated on the new name; the play-open partial unique
 * index is added so only one iteration per environment is the default public-play target; and the
 * standalone `deps_version` column folds into the `config` JSON document (copied per row before the
 * column is dropped) so a run's `config_snapshot` is the single frozen record of what governed it. An
 * already-seeded Stage 5 iteration survives as an `unreleased`, submission-`open`, play-`open`
 * iteration with an empty match design.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    // --- iterations: rename the submission window, add the gates and the config document. ---

    // Drop the old open-submission index before renaming the column it filters on, so the recreate
    // below is unambiguous.
    await db.schema.dropIndex('iterations_open_unique').execute()
    await db.schema.alterTable('iterations').renameColumn('status', 'submission_status').execute()

    // Already-seeded rows become play-`open` for local continuity (operator-created rows set `closed`
    // explicitly); release defaults `unreleased`. `config` carries a throwaway default only so the
    // NOT NULL column can be added to a populated table; every existing row is back-filled below and
    // every new row supplies its own validated document.
    await db.schema
      .alterTable('iterations')
      .addColumn('play_status', 'text', (col) => col.notNull().defaultTo('open'))
      .execute()
    await db.schema
      .alterTable('iterations')
      .addColumn('release_status', 'text', (col) => col.notNull().defaultTo('unreleased'))
      .execute()
    await db.schema.alterTable('iterations').addColumn('label', 'text').execute()
    await db.schema
      .alterTable('iterations')
      .addColumn('config', 'text', (col) => col.notNull().defaultTo('{}'))
      .execute()
    await db.schema.alterTable('iterations').addColumn('rating_prompt', 'text').execute()
    await db.schema.alterTable('iterations').addColumn('released_at', 'text').execute()

    // Fold each existing row's pinned `deps_version` into its `config` document, then drop the column.
    const existing = await sql<{
      id: string
      deps_version: number
    }>`SELECT id, deps_version FROM iterations`.execute(db)
    for (const row of existing.rows) {
      const config = JSON.stringify({ deps_version: row.deps_version, matches: [] })
      await sql`UPDATE iterations SET config = ${config} WHERE id = ${row.id}`.execute(db)
    }
    await db.schema.alterTable('iterations').dropColumn('deps_version').execute()

    // One iteration per environment may accept submissions, and one may be the default public-play
    // target. Partial unique indexes are raw SQL (not in Kysely's schema builder).
    await sql`
      CREATE UNIQUE INDEX iterations_submission_open_unique
      ON iterations (env_id)
      WHERE submission_status = 'open'
    `.execute(db)
    await sql`
      CREATE UNIQUE INDEX iterations_play_open_unique
      ON iterations (env_id)
      WHERE play_status = 'open'
    `.execute(db)

    // --- sessions: iteration attribution (the key ratings later attach to). ---
    await db.schema.alterTable('sessions').addColumn('iteration_id', 'text').execute()

    // --- iteration_runs: one workflow execution. ---
    await db.schema
      .createTable('iteration_runs')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('iteration_id', 'text', (col) => col.notNull())
      .addColumn('requested_by', 'text', (col) => col.notNull())
      .addColumn('config_snapshot', 'text', (col) => col.notNull())
      .addColumn('submission_snapshot', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('started_at', 'text', (col) => col.notNull())
      .addColumn('ended_at', 'text')
      .addColumn('error', 'text')
      .execute()

    // --- iteration_run_games: one scheduled match. ---
    await db.schema
      .createTable('iteration_run_games')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('run_id', 'text', (col) => col.notNull())
      .addColumn('match_index', 'integer', (col) => col.notNull())
      .addColumn('game_index', 'integer', (col) => col.notNull())
      .addColumn('seed', 'integer', (col) => col.notNull())
      .addColumn('slots', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('recording_id', 'text')
      .addColumn('started_at', 'text')
      .addColumn('ended_at', 'text')
      .addColumn('error', 'text')
      .execute()

    // --- game_results: per-seat outcome of a game. ---
    await db.schema
      .createTable('game_results')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('game_id', 'text', (col) => col.notNull())
      .addColumn('slot_index', 'integer', (col) => col.notNull())
      .addColumn('agent_kind', 'text', (col) => col.notNull())
      .addColumn('agent_submission_id', 'text')
      .addColumn('agent_user_id', 'text')
      .addColumn('episode_score', 'real', (col) => col.notNull())
      .addColumn('agent_compute_ms_total', 'real', (col) => col.notNull())
      .addColumn('acted_tick_count', 'integer', (col) => col.notNull())
      .addColumn('failed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('failure_reason', 'text')
      .execute()

    // --- automated_placements: the per-agent placement snapshot. ---
    await db.schema
      .createTable('automated_placements')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('iteration_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('run_id', 'text', (col) => col.notNull())
      .addColumn('rank', 'integer', (col) => col.notNull())
      .addColumn('agent_kind', 'text', (col) => col.notNull())
      .addColumn('agent_submission_id', 'text')
      .addColumn('agent_user_id', 'text')
      .addColumn('mean_score', 'real', (col) => col.notNull())
      .addColumn('mean_agent_compute_ms', 'real')
      .addColumn('failure_count', 'integer', (col) => col.notNull())
      .addColumn('recording_id', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute()

    // --- ratings: one 1-5 human rating per user per agent per iteration. ---
    await db.schema
      .createTable('ratings')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('iteration_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('rater_user_id', 'text', (col) => col.notNull())
      .addColumn('agent_kind', 'text', (col) => col.notNull())
      .addColumn('agent_submission_id', 'text')
      .addColumn('agent_user_id', 'text')
      .addColumn('score', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute()

    // --- agent_rating_prompts: the author's per-iteration prompt (keyed by author, survives resubmit). ---
    await db.schema
      .createTable('agent_rating_prompts')
      .addColumn('iteration_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('prompt', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('agent_rating_prompts_pk', ['iteration_id', 'user_id'])
      .execute()

    // --- hot-read and uniqueness indexes. ---
    await db.schema
      .createIndex('iteration_runs_iteration')
      .on('iteration_runs')
      .column('iteration_id')
      .execute()
    await db.schema
      .createIndex('iteration_run_games_run_game')
      .on('iteration_run_games')
      .columns(['run_id', 'game_index'])
      .execute()
    await db.schema.createIndex('game_results_game').on('game_results').column('game_id').execute()
    await db.schema
      .createIndex('game_results_agent')
      .on('game_results')
      .columns(['agent_kind', 'agent_submission_id'])
      .execute()
    await db.schema
      .createIndex('automated_placements_agent_env')
      .on('automated_placements')
      .columns(['agent_kind', 'agent_submission_id', 'env_id'])
      .execute()
    await db.schema
      .createIndex('ratings_iteration_agent')
      .on('ratings')
      .columns(['iteration_id', 'agent_kind', 'agent_submission_id'])
      .execute()

    // Placement uniqueness: submitted agents key on the submission id; the null-submission Naive row
    // gets a second partial index (SQLite treats nulls as distinct).
    await sql`
      CREATE UNIQUE INDEX automated_placements_submission_unique
      ON automated_placements (iteration_id, agent_kind, agent_submission_id)
    `.execute(db)
    await sql`
      CREATE UNIQUE INDEX automated_placements_naive_unique
      ON automated_placements (iteration_id, agent_kind)
      WHERE agent_kind = 'builtin-naive'
    `.execute(db)

    // Rating uniqueness: one effective rating per user per agent per iteration, with the Naive row
    // covered by a second partial index for the same null-distinctness reason.
    await sql`
      CREATE UNIQUE INDEX ratings_one_per_user_agent
      ON ratings (iteration_id, rater_user_id, agent_kind, agent_submission_id)
    `.execute(db)
    await sql`
      CREATE UNIQUE INDEX ratings_one_per_user_naive
      ON ratings (iteration_id, rater_user_id, agent_kind)
      WHERE agent_kind = 'builtin-naive'
    `.execute(db)
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('agent_rating_prompts').execute()
    await db.schema.dropTable('ratings').execute()
    await db.schema.dropTable('automated_placements').execute()
    await db.schema.dropTable('game_results').execute()
    await db.schema.dropTable('iteration_run_games').execute()
    await db.schema.dropTable('iteration_runs').execute()

    await db.schema.alterTable('sessions').dropColumn('iteration_id').execute()

    await db.schema.dropIndex('iterations_play_open_unique').execute()
    await db.schema.dropIndex('iterations_submission_open_unique').execute()

    // Restore the standalone deps_version column from each row's config document, then drop the
    // Stage 6 columns and rename the submission window back to `status`.
    await db.schema
      .alterTable('iterations')
      .addColumn('deps_version', 'integer', (col) => col.notNull().defaultTo(1))
      .execute()
    const rows = await sql<{
      id: string
      config: string
    }>`SELECT id, config FROM iterations`.execute(db)
    for (const row of rows.rows) {
      let depsVersion = 1
      try {
        const parsed = JSON.parse(row.config) as { deps_version?: unknown }
        if (typeof parsed.deps_version === 'number') {
          depsVersion = parsed.deps_version
        }
      } catch {
        // Leave the default if the document is unreadable.
      }
      await sql`UPDATE iterations SET deps_version = ${depsVersion} WHERE id = ${row.id}`.execute(
        db,
      )
    }

    await db.schema.alterTable('iterations').dropColumn('released_at').execute()
    await db.schema.alterTable('iterations').dropColumn('rating_prompt').execute()
    await db.schema.alterTable('iterations').dropColumn('config').execute()
    await db.schema.alterTable('iterations').dropColumn('label').execute()
    await db.schema.alterTable('iterations').dropColumn('release_status').execute()
    await db.schema.alterTable('iterations').dropColumn('play_status').execute()
    await db.schema.alterTable('iterations').renameColumn('submission_status', 'status').execute()
    await sql`
      CREATE UNIQUE INDEX iterations_open_unique
      ON iterations (env_id)
      WHERE status = 'open'
    `.execute(db)
  },
}
