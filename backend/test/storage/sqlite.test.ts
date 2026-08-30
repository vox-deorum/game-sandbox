import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { CURRENT_SCHEMA_VERSION } from '../../src/storage/migrations/index.js'
import { openSqlite } from '../../src/storage/sqlite.js'

describe('SQLite schema version', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  function databasePath(): string {
    dir = mkdtempSync(join(tmpdir(), 'gs-sqlite-'))
    return join(dir, 'sandbox.db')
  }

  it('marks a fresh database with the current schema version', async () => {
    const handle = await openSqlite(databasePath())
    expect(handle.sqlite.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION)
    await handle.storage.close()
  })

  it('upgrades the legacy ratings schema without losing existing scores', async () => {
    const path = databasePath()
    const legacy = new BetterSqlite3(path)
    legacy.exec(`
      CREATE TABLE ratings (
        id TEXT PRIMARY KEY,
        season_id TEXT NOT NULL,
        env_id TEXT NOT NULL,
        rater_user_id TEXT NOT NULL,
        agent_kind TEXT NOT NULL,
        agent_submission_id TEXT,
        agent_user_id TEXT,
        score INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX ratings_season_agent
        ON ratings (season_id, agent_kind, agent_submission_id);
      CREATE UNIQUE INDEX ratings_one_per_user_agent
        ON ratings (season_id, rater_user_id, agent_kind, agent_submission_id);
      CREATE UNIQUE INDEX ratings_one_per_user_naive
        ON ratings (season_id, rater_user_id, agent_kind)
        WHERE agent_kind = 'builtin-naive';
      INSERT INTO ratings VALUES
        ('submission-rating', 'season-1', 'flappy_bird', 'rater-1', 'submission', 'sub-1',
         'owner-1', 4, '2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z'),
        ('builtin-rating', 'season-1', 'flappy_bird', 'rater-1', 'builtin-naive', NULL,
         NULL, 3, '2026-06-03T00:00:00.000Z', '2026-06-04T00:00:00.000Z');
      CREATE TABLE kysely_migration (
        name VARCHAR(255) NOT NULL PRIMARY KEY,
        timestamp VARCHAR(255) NOT NULL
      );
      INSERT INTO kysely_migration VALUES ('0001_initial_schema', '2026-06-01T00:00:00.000Z');
      CREATE TABLE kysely_migration_lock (
        id VARCHAR(255) NOT NULL PRIMARY KEY,
        is_locked INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO kysely_migration_lock VALUES ('migration_lock', 0);
    `)
    legacy.close()

    const handle = await openSqlite(path)
    const columns = handle.sqlite
      .prepare('PRAGMA table_info(ratings)')
      .all()
      .map((column) => (column as { name: string }).name)
    expect(columns).toContain('agent_builtin_name')
    expect(columns).toContain('feedback')
    expect(handle.sqlite.prepare('SELECT * FROM ratings ORDER BY id').all()).toMatchObject([
      {
        id: 'builtin-rating',
        agent_kind: 'builtin',
        agent_builtin_name: 'naive',
        score: 3,
        feedback: '',
        created_at: '2026-06-03T00:00:00.000Z',
        updated_at: '2026-06-04T00:00:00.000Z',
      },
      {
        id: 'submission-rating',
        agent_kind: 'submission',
        agent_builtin_name: null,
        score: 4,
        feedback: '',
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-02T00:00:00.000Z',
      },
    ])
    expect(handle.sqlite.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION)
    expect(
      handle.sqlite
        .prepare('SELECT name FROM kysely_migration ORDER BY name')
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(['0001_initial_schema', '0002_legacy_ratings_schema'])
    await handle.storage.close()
  })
})
