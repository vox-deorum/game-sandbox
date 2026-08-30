/**
 * The current schema for a fresh database: version {@link CURRENT_SCHEMA_VERSION}.
 *
 * This migration builds every table and index directly when the database has no app migration
 * ledger. Deployed databases have already recorded it, so every schema change made here must also
 * append equivalent retry-safe forward steps to the latest migration named in `index.ts`.
 *
 * Partial unique indexes are not in Kysely's schema builder, so those are raw `CREATE UNIQUE INDEX`
 * statements. Kysely types migration functions `Kysely<any>` (the schema can differ from the current
 * `Database` mid-history); because this flat migration always builds exactly the current schema, the
 * `up`/`down` functions take the accurate `Kysely<Database>` and stay off `any`.
 *
 * Better Auth's tables (`user`, `session`, `account`, `verification`) are **not** here. They are
 * library-owned: their exact shape follows the installed `better-auth` version and the enabled
 * plugins, so `backend/src/auth/migrate.ts` creates them with Better Auth's own programmatic
 * migration, on the same connection, right after this app schema is built. None of those singular
 * names collides with this schema's plural `sessions`/`recordings`.
 */
import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

import type { Database } from '../schema.js'

/**
 * The schema version this fresh migration builds. Change it only when the project owner directs a
 * version bump. Schema updates within the current version extend the latest migration instead.
 */
export const CURRENT_SCHEMA_VERSION = 2

/** Build the current ratings indexes for a fresh database. */
async function createRatingsIndexes(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createIndex('ratings_season_agent')
    .on('ratings')
    .columns(['season_id', 'agent_kind', 'agent_builtin_name', 'agent_submission_id'])
    .execute()
  // The owner-feedback read on the agent profile lists one owner's ratings across seasons, so keep
  // that request on an owner-bounded index rather than scanning every season's ratings.
  await db.schema
    .createIndex('ratings_env_agent_user')
    .on('ratings')
    .columns(['env_id', 'agent_user_id'])
    .execute()
  // Rating uniqueness: one effective rating per user per agent per season.
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

/** Build the current schema for a fresh database. Keep `up` and `down` synchronized. */
export const initialSchema: Migration = {
  async up(db: Kysely<Database>): Promise<void> {
    // --- sessions: one row per launched session. ---
    await db.schema
      .createTable('sessions')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('mode', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('termination_reason', 'text')
      .addColumn('recording_id', 'text')
      .addColumn('season_id', 'text')
      .addColumn('human_timeout_ms', 'integer')
      .addColumn('messaging_enabled', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('message_cap', 'integer')
      .addColumn('llm_enabled', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('parameters', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('ended_at', 'text')
      .execute()
    await db.schema
      .createIndex('sessions_user_status')
      .on('sessions')
      .columns(['user_id', 'status'])
      .execute()

    // --- recordings: retention metadata, one row per produced recording. ---
    await db.schema
      .createTable('recordings')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('pinned', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('termination_reason', 'text')
      .addColumn('llm_scope_id', 'text')
      .addColumn('llm_session_id', 'text')
      .execute()
    await db.schema
      .createIndex('recordings_user_created')
      .on('recordings')
      .columns(['user_id', 'created_at'])
      .execute()

    // --- recording_cleanup_queue: durable filesystem and final-scope telemetry cleanup. ---
    await db.schema
      .createTable('recording_cleanup_queue')
      .addColumn('recording_id', 'text', (col) => col.primaryKey())
      .addColumn('llm_scope_id', 'text')
      .execute()
    await sql`
      CREATE TRIGGER recordings_queue_cleanup
      BEFORE DELETE ON recordings
      FOR EACH ROW
      BEGIN
        INSERT INTO recording_cleanup_queue (recording_id, llm_scope_id)
        VALUES (
          OLD.id,
          CASE
            WHEN OLD.llm_scope_id IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM recordings AS other
              WHERE other.llm_scope_id = OLD.llm_scope_id AND other.id <> OLD.id
            ) THEN OLD.llm_scope_id
            ELSE NULL
          END
        );
      END
    `.execute(db)

    // --- seasons: one row per environment's competition season. ---
    await db.schema
      .createTable('seasons')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('submission_status', 'text', (col) => col.notNull())
      .addColumn('play_status', 'text', (col) => col.notNull())
      .addColumn('release_status', 'text', (col) => col.notNull())
      .addColumn('label', 'text')
      .addColumn('description_markdown', 'text')
      .addColumn('template_repo_url', 'text')
      .addColumn('config', 'text', (col) => col.notNull())
      .addColumn('rating_prompt', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('released_at', 'text')
      .addColumn(
        // `'playground'` for the seed-ensured open row, `template:<preset name>` for a seed
        // template, null for operator-made seasons. The season seed uses it to keep its own rows
        // apart from operator configuration; it never leaves the backend over the public wire.
        'template_source',
        'text',
      )
      .execute()
    // One season per environment may accept submissions, and one may be the default public-play
    // target. Partial unique indexes are raw SQL (not in Kysely's schema builder).
    // The seed grounds its template creates on this unique (env_id, template_source) key, so a
    // racing boot cannot double the arc. Binary partial indexes are the house style for one-winner
    // per-environment invariants; operator rows (NULL) and the single Playground marker stay out,
    // so closing and re-supplying an open Playground remains possible.
    await sql`
      CREATE UNIQUE INDEX seasons_template_source_unique
      ON seasons (env_id, template_source)
      WHERE template_source IS NOT NULL AND template_source <> 'playground'
    `.execute(db)
    // One season per environment may accept submissions, and one may be the default public-play
    // target. Partial unique indexes are raw SQL (not in Kysely's schema builder).
    await sql`
      CREATE UNIQUE INDEX seasons_submission_open_unique
      ON seasons (env_id)
      WHERE submission_status = 'open'
    `.execute(db)
    await sql`
      CREATE UNIQUE INDEX seasons_play_open_unique
      ON seasons (env_id)
      WHERE play_status = 'open'
    `.execute(db)
    await db.schema
      .createTable('season_seed_flags')
      .addColumn('env_id', 'text', (col) => col.primaryKey())
      .addColumn('templates_planted', 'integer', (col) => col.notNull().defaultTo(0))
      .execute()

    // --- submissions: one row per submitted agent. ---
    await db.schema
      .createTable('submissions')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('season_id', 'text', (col) => col.notNull())
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
    // The one-active-submission-per-participant-per-season rule, enforced at the storage layer.
    await sql`
      CREATE UNIQUE INDEX submissions_active_unique
      ON submissions (season_id, user_id)
      WHERE superseded_at IS NULL
    `.execute(db)
    await db.schema
      .createIndex('submissions_season_user')
      .on('submissions')
      .columns(['season_id', 'user_id'])
      .execute()
    await db.schema
      .createIndex('submissions_user_env')
      .on('submissions')
      .columns(['user_id', 'env_id'])
      .execute()

    // --- session_submissions: which submitted agent ran in which session seat. ---
    await db.schema
      .createTable('session_submissions')
      .addColumn('session_id', 'text', (col) => col.notNull())
      .addColumn('submission_id', 'text', (col) => col.notNull())
      .addColumn('seat_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('session_submissions_pk', ['session_id', 'seat_id'])
      .execute()
    await db.schema
      .createIndex('session_submissions_submission')
      .on('session_submissions')
      .column('submission_id')
      .execute()

    // --- submission_checks: the ordered per-stage validation log. ---
    await db.schema
      .createTable('submission_checks')
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
      .unique()
      .on('submission_checks')
      .columns(['submission_id', 'stage'])
      .execute()
    await db.schema
      .createIndex('submission_checks_submission')
      .on('submission_checks')
      .column('submission_id')
      .execute()

    // --- season_runs: one workflow execution. ---
    await db.schema
      .createTable('season_runs')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('season_id', 'text', (col) => col.notNull())
      .addColumn('requested_by', 'text', (col) => col.notNull())
      .addColumn('config_snapshot', 'text', (col) => col.notNull())
      .addColumn('parameters_snapshot', 'text', (col) => col.notNull())
      .addColumn('llm_policy_snapshot', 'text', (col) => col.notNull())
      .addColumn('submission_snapshot', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('started_at', 'text', (col) => col.notNull())
      .addColumn('ended_at', 'text')
      .addColumn('error', 'text')
      .execute()
    await db.schema
      .createIndex('season_runs_season')
      .on('season_runs')
      .column('season_id')
      .execute()

    // --- season_run_games: one scheduled match. ---
    await db.schema
      .createTable('season_run_games')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('run_id', 'text', (col) => col.notNull())
      .addColumn('match_index', 'integer', (col) => col.notNull())
      .addColumn('game_index', 'integer', (col) => col.notNull())
      .addColumn('seed', 'integer', (col) => col.notNull())
      .addColumn('seats', 'text', (col) => col.notNull())
      .addColumn('seat_plan', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('recording_id', 'text')
      .addColumn('started_at', 'text')
      .addColumn('ended_at', 'text')
      .addColumn('error', 'text')
      .execute()
    await db.schema
      .createIndex('season_run_games_run_game')
      .on('season_run_games')
      .columns(['run_id', 'game_index'])
      .execute()

    // --- game_results: per-seat outcome of a game. ---
    await db.schema
      .createTable('game_results')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('game_id', 'text', (col) => col.notNull())
      .addColumn('seat_index', 'integer', (col) => col.notNull())
      .addColumn('agent_kind', 'text', (col) => col.notNull())
      .addColumn('agent_builtin_name', 'text')
      .addColumn('agent_submission_id', 'text')
      .addColumn('agent_user_id', 'text')
      .addColumn('episode_score', 'real', (col) => col.notNull())
      .addColumn('agent_compute_ms_total', 'real', (col) => col.notNull())
      .addColumn('acted_tick_count', 'integer', (col) => col.notNull())
      .addColumn('llm_usage_by_model', 'text')
      .addColumn('llm_weighted_cost', 'real')
      .addColumn('failed', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('failure_reason', 'text')
      .execute()
    await db.schema.createIndex('game_results_game').on('game_results').column('game_id').execute()
    await db.schema
      .createIndex('game_results_agent')
      .on('game_results')
      .columns(['agent_kind', 'agent_builtin_name', 'agent_submission_id'])
      .execute()

    // --- automated_placements: the per-agent placement snapshot. ---
    await db.schema
      .createTable('automated_placements')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('season_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('run_id', 'text', (col) => col.notNull())
      .addColumn('rank', 'integer', (col) => col.notNull())
      .addColumn('agent_kind', 'text', (col) => col.notNull())
      .addColumn('agent_builtin_name', 'text')
      .addColumn('agent_submission_id', 'text')
      .addColumn('agent_user_id', 'text')
      .addColumn('mean_score', 'real', (col) => col.notNull())
      .addColumn('mean_agent_compute_ms', 'real')
      .addColumn('llm_usage_by_model', 'text')
      .addColumn('llm_weighted_cost', 'real')
      .addColumn('failure_count', 'integer', (col) => col.notNull())
      .addColumn('recording_id', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute()
    await db.schema
      .createIndex('automated_placements_agent_env')
      .on('automated_placements')
      .columns(['agent_kind', 'agent_builtin_name', 'agent_submission_id', 'env_id'])
      .execute()
    // The signed-in user's season summary reads all submitted-agent placements for one owner. Keep
    // that request on an owner-bounded index rather than scanning every environment's placements;
    // season_id is covered because response assembly groups the result by season.
    await sql`
      CREATE INDEX automated_placements_user_season
      ON automated_placements (agent_user_id, season_id)
      WHERE agent_kind = 'submission'
    `.execute(db)
    // Placement uniqueness: submitted agents key on the submission id, built-ins on their stable name.
    await sql`
      CREATE UNIQUE INDEX automated_placements_submission_unique
      ON automated_placements (season_id, agent_kind, agent_submission_id)
      WHERE agent_kind = 'submission'
    `.execute(db)
    await sql`
      CREATE UNIQUE INDEX automated_placements_builtin_unique
      ON automated_placements (season_id, agent_kind, agent_builtin_name)
      WHERE agent_kind = 'builtin'
    `.execute(db)

    // --- ratings: one 1-5 human rating per user per agent per season. ---
    await db.schema
      .createTable('ratings')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('season_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('rater_user_id', 'text', (col) => col.notNull())
      .addColumn('agent_kind', 'text', (col) => col.notNull())
      .addColumn('agent_builtin_name', 'text')
      .addColumn('agent_submission_id', 'text')
      .addColumn('agent_user_id', 'text')
      .addColumn('score', 'integer', (col) => col.notNull())
      .addColumn('feedback', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute()
    await createRatingsIndexes(db)

    // --- agent_rating_prompts: the author's per-season prompt (keyed by author, survives resubmit). ---
    await db.schema
      .createTable('agent_rating_prompts')
      .addColumn('season_id', 'text', (col) => col.notNull())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('prompt', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('agent_rating_prompts_pk', ['season_id', 'user_id'])
      .execute()

    await db.schema
      .createTable('llm_development_keys')
      .addColumn('season_id', 'text', (col) => col.notNull())
      .addColumn('user_id', 'text', (col) => col.notNull())
      .addColumn('key_id', 'text', (col) => col.notNull())
      .addColumn('secret_hash', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('rotated_at', 'text')
      .addPrimaryKeyConstraint('llm_development_keys_pk', ['season_id', 'user_id'])
      .execute()
    await db.schema
      .createIndex('llm_development_keys_key_id')
      .unique()
      .on('llm_development_keys')
      .column('key_id')
      .execute()
    await sql.raw(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`).execute(db)
  },

  async down(db: Kysely<Database>): Promise<void> {
    await sql`DROP TRIGGER IF EXISTS recordings_queue_cleanup`.execute(db)
    // Drop in reverse dependency order; each table's indexes go with it.
    for (const table of [
      'llm_development_keys',
      'agent_rating_prompts',
      'ratings',
      'automated_placements',
      'game_results',
      'season_run_games',
      'season_runs',
      'submission_checks',
      'session_submissions',
      'submissions',
      'season_seed_flags',
      'seasons',
      'recording_cleanup_queue',
      'recordings',
      'sessions',
    ]) {
      await db.schema.dropTable(table).execute()
    }
    await sql.raw('PRAGMA user_version = 0').execute(db)
  },
}
