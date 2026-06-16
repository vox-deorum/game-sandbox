/**
 * Migration coverage for Stage 6.1 (004_stage6_leaderboards), entirely on better-sqlite3 `:memory:`.
 * It seeds a genuine Stage 5 iteration row between migrations 003 and 004, then proves the Stage 6
 * migration renames `status` to `submission_status`, adds the play/release gates with their defaults,
 * folds `deps_version` into the `config` document, creates the six new tables and their indexes, and
 * is a no-op on a second run.
 */
import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { Migrator } from 'kysely/migration'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrationProvider } from '../src/storage/migrations/index.js'

describe('stage 6 migration (004_stage6_leaderboards)', () => {
  // The migrations only run raw SQL, so an untyped schema is all this harness needs.
  let db: Kysely<Record<string, never>>
  let migrator: Migrator

  beforeEach(() => {
    const sqlite = new BetterSqlite3(':memory:')
    sqlite.pragma('foreign_keys = ON')
    db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) })
    migrator = new Migrator({ db, provider: migrationProvider })
  })

  afterEach(async () => {
    await db.destroy()
  })

  async function seedStage5AndMigrate(): Promise<void> {
    const to003 = await migrator.migrateTo('003_create_submissions')
    expect(to003.error).toBeUndefined()
    await sql`
      INSERT INTO iterations (id, env_id, deps_version, status, created_at)
      VALUES ('it-seed', 'flappy_bird', 1, 'open', '2026-01-01T00:00:00.000Z')
    `.execute(db)
    const toLatest = await migrator.migrateToLatest()
    expect(toLatest.error).toBeUndefined()
  }

  it('migrates a seeded Stage 5 iteration to an unreleased, submission-open, play-open row', async () => {
    await seedStage5AndMigrate()
    const row = await sql<{
      id: string
      submission_status: string
      play_status: string
      release_status: string
      config: string
      rating_prompt: string | null
      released_at: string | null
    }>`SELECT * FROM iterations WHERE id = 'it-seed'`.execute(db)
    const it = row.rows.at(0)
    expect(it?.submission_status).toBe('open')
    expect(it?.play_status).toBe('open')
    expect(it?.release_status).toBe('unreleased')
    expect(it?.rating_prompt).toBeNull()
    expect(it?.released_at).toBeNull()
    // deps_version folded into config with an empty match design; the standalone column is gone.
    expect(JSON.parse(it?.config ?? '{}')).toEqual({ deps_version: 1, matches: [] })
    expect(it !== undefined && 'deps_version' in it).toBe(false)
  })

  it('recreates the open-submission index on the renamed column and adds the play-open index', async () => {
    await seedStage5AndMigrate()
    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'iterations'
    `.execute(db)
    const names = indexes.rows.map((r) => r.name)
    expect(names).toContain('iterations_submission_open_unique')
    expect(names).toContain('iterations_play_open_unique')
    expect(names).not.toContain('iterations_open_unique')

    // The one-open-submission invariant still holds on the renamed column.
    await expect(
      sql`
        INSERT INTO iterations (id, env_id, submission_status, play_status, release_status, config, created_at)
        VALUES ('it-2', 'flappy_bird', 'open', 'closed', 'unreleased', '{"deps_version":1,"matches":[]}', '2026-01-02T00:00:00.000Z')
      `.execute(db),
    ).rejects.toThrow(/UNIQUE/)
  })

  it('creates the six new leaderboard tables', async () => {
    await seedStage5AndMigrate()
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `.execute(db)
    const names = tables.rows.map((r) => r.name)
    for (const table of [
      'iteration_runs',
      'iteration_run_games',
      'game_results',
      'automated_placements',
      'ratings',
      'agent_rating_prompts',
    ]) {
      expect(names).toContain(table)
    }
  })

  it('adds a nullable iteration_id to sessions', async () => {
    await seedStage5AndMigrate()
    const cols = await sql<{ name: string; notnull: number }>`
      PRAGMA table_info('sessions')
    `.execute(db)
    const iterationCol = cols.rows.find((c) => c.name === 'iteration_id')
    expect(iterationCol).toBeDefined()
    expect(iterationCol?.notnull).toBe(0)
  })

  it('is a no-op on a second migrateToLatest run', async () => {
    await seedStage5AndMigrate()
    const again = await migrator.migrateToLatest()
    expect(again.error).toBeUndefined()
    expect(again.results?.every((r) => r.status === 'Success' || r.status === undefined)).toBe(true)
  })
})
