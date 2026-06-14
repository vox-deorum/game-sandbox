/**
 * The third migration: the submission tables (`iterations`, `submissions`, `session_submissions`,
 * `submission_checks`), their indexes, and the three uniqueness constraints the rest of Stage 5
 * relies on.
 *
 * It is additive over the Stage 3/4 migrations and rewrites no existing rows. The active-submission
 * partial unique index (`(iteration_id, user_id) WHERE superseded_at IS NULL`) enforces the
 * one-active-submission-per-participant-per-iteration rule at the storage layer rather than in a
 * route; the `(submission_id, stage)` unique index keeps a re-enqueued submission's per-stage log
 * to one row per stage; and the open-iteration partial unique index (`(env_id) WHERE status =
 * 'open'`) keeps one open iteration per environment, which `ensureOpenIteration` relies on to make
 * the seed race-safe. The named foreign-key indexes back the hot lookups the later steps run
 * (active-submission rule, agent-profile history, polled validation log, profile recordings) so
 * those reads do not table-scan.
 */
import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import type { Migration } from 'kysely/migration'

export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('iterations')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('env_id', 'text', (col) => col.notNull())
      .addColumn('deps_version', 'integer', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .execute()

    await db.schema
      .createTable('submissions')
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

    await db.schema
      .createTable('session_submissions')
      .addColumn('session_id', 'text', (col) => col.notNull())
      .addColumn('submission_id', 'text', (col) => col.notNull())
      .addColumn('slot_id', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addPrimaryKeyConstraint('session_submissions_pk', ['session_id', 'slot_id'])
      .execute()

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

    // The one-active-submission-per-participant-per-iteration rule, enforced at the storage layer.
    // Partial unique indexes are not in Kysely's schema builder, so this is raw SQL.
    await sql`
      CREATE UNIQUE INDEX submissions_active_unique
      ON submissions (iteration_id, user_id)
      WHERE superseded_at IS NULL
    `.execute(db)

    // One per-stage check row per submission, so a re-enqueue overwrites rather than appends.
    await db.schema
      .createIndex('submission_checks_submission_stage_unique')
      .unique()
      .on('submission_checks')
      .columns(['submission_id', 'stage'])
      .execute()

    // Only one open iteration per environment at a time (the seed and Stage 6 both rely on this).
    await sql`
      CREATE UNIQUE INDEX iterations_open_unique
      ON iterations (env_id)
      WHERE status = 'open'
    `.execute(db)

    // Foreign-key / lookup indexes for the hot reads the later steps run.
    await db.schema
      .createIndex('submissions_iteration_user')
      .on('submissions')
      .columns(['iteration_id', 'user_id'])
      .execute()
    await db.schema
      .createIndex('submissions_user_env')
      .on('submissions')
      .columns(['user_id', 'env_id'])
      .execute()
    await db.schema
      .createIndex('submission_checks_submission')
      .on('submission_checks')
      .column('submission_id')
      .execute()
    await db.schema
      .createIndex('session_submissions_submission')
      .on('session_submissions')
      .column('submission_id')
      .execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('session_submissions_submission').execute()
    await db.schema.dropIndex('submission_checks_submission').execute()
    await db.schema.dropIndex('submissions_user_env').execute()
    await db.schema.dropIndex('submissions_iteration_user').execute()
    await db.schema.dropIndex('iterations_open_unique').execute()
    await db.schema.dropIndex('submission_checks_submission_stage_unique').execute()
    await db.schema.dropIndex('submissions_active_unique').execute()
    await db.schema.dropTable('submission_checks').execute()
    await db.schema.dropTable('session_submissions').execute()
    await db.schema.dropTable('submissions').execute()
    await db.schema.dropTable('iterations').execute()
  },
}
