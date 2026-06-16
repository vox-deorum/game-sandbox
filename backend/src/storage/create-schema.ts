/**
 * The schema bootstrap: create every table and index in their final shape, directly.
 *
 * There is no versioned migration history — this is a dev codebase with no deployed data to
 * preserve, so the schema is built fresh from one authoritative definition rather than replayed
 * through a chain of `up` steps. `sqlite.ts` calls this once at open time. Every `createTable`/
 * `createIndex` is `ifNotExists`, so reopening an existing database file is a no-op rather than an
 * error (the file-database reopen test relies on this).
 *
 * Partial unique indexes are not in Kysely's schema builder, so those are raw `CREATE UNIQUE INDEX
 * IF NOT EXISTS` statements.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'

import type { Database } from './schema.js'

/** Build the full schema on a fresh (or existing) database. Idempotent: safe to call on reopen. */
export async function createSchema(db: Kysely<Database>): Promise<void> {
  // --- sessions: one row per launched session. ---
  await db.schema
    .createTable('sessions')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('env_id', 'text', (col) => col.notNull())
    .addColumn('mode', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('termination_reason', 'text')
    .addColumn('recording_id', 'text')
    .addColumn('iteration_id', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('ended_at', 'text')
    .execute()
  await db.schema
    .createIndex('sessions_user_status')
    .ifNotExists()
    .on('sessions')
    .columns(['user_id', 'status'])
    .execute()

  // --- recordings: retention metadata, one row per produced recording. ---
  await db.schema
    .createTable('recordings')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('env_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('pinned', 'integer', (col) => col.notNull().defaultTo(0))
    .execute()
  await db.schema
    .createIndex('recordings_user_created')
    .ifNotExists()
    .on('recordings')
    .columns(['user_id', 'created_at'])
    .execute()

  // --- iterations: one row per environment's competition iteration. ---
  await db.schema
    .createTable('iterations')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('env_id', 'text', (col) => col.notNull())
    .addColumn('submission_status', 'text', (col) => col.notNull())
    .addColumn('play_status', 'text', (col) => col.notNull())
    .addColumn('release_status', 'text', (col) => col.notNull())
    .addColumn('label', 'text')
    .addColumn('config', 'text', (col) => col.notNull())
    .addColumn('rating_prompt', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('released_at', 'text')
    .execute()
  // One iteration per environment may accept submissions, and one may be the default public-play
  // target. Partial unique indexes are raw SQL (not in Kysely's schema builder).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS iterations_submission_open_unique
    ON iterations (env_id)
    WHERE submission_status = 'open'
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS iterations_play_open_unique
    ON iterations (env_id)
    WHERE play_status = 'open'
  `.execute(db)

  // --- submissions: one row per submitted agent. ---
  await db.schema
    .createTable('submissions')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('iteration_id', 'text', (col) => col.notNull())
    .addColumn('env_id', 'text', (col) => col.notNull())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('source_kind', 'text', (col) => col.notNull())
    .addColumn('repo_url', 'text')
    .addColumn('commit_sha', 'text')
    .addColumn('local_path', 'text')
    .addColumn('ref', 'text')
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('reason', 'text')
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addColumn('superseded_at', 'text')
    .execute()
  // The one-active-submission-per-participant-per-iteration rule, enforced at the storage layer.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS submissions_active_unique
    ON submissions (iteration_id, user_id)
    WHERE superseded_at IS NULL
  `.execute(db)
  await db.schema
    .createIndex('submissions_iteration_user')
    .ifNotExists()
    .on('submissions')
    .columns(['iteration_id', 'user_id'])
    .execute()
  await db.schema
    .createIndex('submissions_user_env')
    .ifNotExists()
    .on('submissions')
    .columns(['user_id', 'env_id'])
    .execute()

  // --- session_submissions: which submitted agent ran in which session slot. ---
  await db.schema
    .createTable('session_submissions')
    .ifNotExists()
    .addColumn('session_id', 'text', (col) => col.notNull())
    .addColumn('submission_id', 'text', (col) => col.notNull())
    .addColumn('slot_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('session_submissions_pk', ['session_id', 'slot_id'])
    .execute()
  await db.schema
    .createIndex('session_submissions_submission')
    .ifNotExists()
    .on('session_submissions')
    .column('submission_id')
    .execute()

  // --- submission_checks: the ordered per-stage validation log. ---
  await db.schema
    .createTable('submission_checks')
    .ifNotExists()
    .addColumn('id', 'text', (col) => col.primaryKey())
    .addColumn('submission_id', 'text', (col) => col.notNull())
    .addColumn('stage', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull())
    .addColumn('detail', 'text')
    .addColumn('started_at', 'text', (col) => col.notNull())
    .addColumn('ended_at', 'text')
    .execute()
  // One per-stage check row per submission, so a re-enqueue overwrites rather than appends.
  await db.schema
    .createIndex('submission_checks_submission_stage_unique')
    .ifNotExists()
    .unique()
    .on('submission_checks')
    .columns(['submission_id', 'stage'])
    .execute()
  await db.schema
    .createIndex('submission_checks_submission')
    .ifNotExists()
    .on('submission_checks')
    .column('submission_id')
    .execute()

  // --- iteration_runs: one workflow execution. ---
  await db.schema
    .createTable('iteration_runs')
    .ifNotExists()
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
  await db.schema
    .createIndex('iteration_runs_iteration')
    .ifNotExists()
    .on('iteration_runs')
    .column('iteration_id')
    .execute()

  // --- iteration_run_games: one scheduled match. ---
  await db.schema
    .createTable('iteration_run_games')
    .ifNotExists()
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
  await db.schema
    .createIndex('iteration_run_games_run_game')
    .ifNotExists()
    .on('iteration_run_games')
    .columns(['run_id', 'game_index'])
    .execute()

  // --- game_results: per-seat outcome of a game. ---
  await db.schema
    .createTable('game_results')
    .ifNotExists()
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
  await db.schema
    .createIndex('game_results_game')
    .ifNotExists()
    .on('game_results')
    .column('game_id')
    .execute()
  await db.schema
    .createIndex('game_results_agent')
    .ifNotExists()
    .on('game_results')
    .columns(['agent_kind', 'agent_submission_id'])
    .execute()

  // --- automated_placements: the per-agent placement snapshot. ---
  await db.schema
    .createTable('automated_placements')
    .ifNotExists()
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
  await db.schema
    .createIndex('automated_placements_agent_env')
    .ifNotExists()
    .on('automated_placements')
    .columns(['agent_kind', 'agent_submission_id', 'env_id'])
    .execute()
  // Placement uniqueness: submitted agents key on the submission id; the null-submission Naive row
  // gets a second partial index (SQLite treats nulls as distinct).
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS automated_placements_submission_unique
    ON automated_placements (iteration_id, agent_kind, agent_submission_id)
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS automated_placements_naive_unique
    ON automated_placements (iteration_id, agent_kind)
    WHERE agent_kind = 'builtin-naive'
  `.execute(db)

  // --- ratings: one 1-5 human rating per user per agent per iteration. ---
  await db.schema
    .createTable('ratings')
    .ifNotExists()
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
  await db.schema
    .createIndex('ratings_iteration_agent')
    .ifNotExists()
    .on('ratings')
    .columns(['iteration_id', 'agent_kind', 'agent_submission_id'])
    .execute()
  // Rating uniqueness: one effective rating per user per agent per iteration, with the Naive row
  // covered by a second partial index for the same null-distinctness reason.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ratings_one_per_user_agent
    ON ratings (iteration_id, rater_user_id, agent_kind, agent_submission_id)
  `.execute(db)
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ratings_one_per_user_naive
    ON ratings (iteration_id, rater_user_id, agent_kind)
    WHERE agent_kind = 'builtin-naive'
  `.execute(db)

  // --- agent_rating_prompts: the author's per-iteration prompt (keyed by author, survives resubmit). ---
  await db.schema
    .createTable('agent_rating_prompts')
    .ifNotExists()
    .addColumn('iteration_id', 'text', (col) => col.notNull())
    .addColumn('env_id', 'text', (col) => col.notNull())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('prompt', 'text', (col) => col.notNull())
    .addColumn('updated_at', 'text', (col) => col.notNull())
    .addPrimaryKeyConstraint('agent_rating_prompts_pk', ['iteration_id', 'user_id'])
    .execute()
}
