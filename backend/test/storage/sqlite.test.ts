import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { openSqlite } from '../../src/storage/sqlite.js'

/** Only the project owner may start the next migration batch, so this stays 3 until they do. */
const APPROVED_SCHEMA_VERSION = 3

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

  it('keeps fresh databases on the owner-approved schema version', async () => {
    const handle = await openSqlite(databasePath())
    expect(handle.sqlite.pragma('user_version', { simple: true })).toBe(APPROVED_SCHEMA_VERSION)
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
      CREATE TABLE seasons (
        id TEXT PRIMARY KEY,
        env_id TEXT NOT NULL,
        template_repo_url TEXT
      );
      INSERT INTO seasons VALUES ('season-1', 'flappy_bird', NULL);
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
    expect(handle.sqlite.pragma('user_version', { simple: true })).toBe(APPROVED_SCHEMA_VERSION)
    expect(handle.sqlite.prepare('SELECT * FROM seasons').all()).toEqual([
      {
        id: 'season-1',
        env_id: 'flappy_bird',
        template_repo_url: null,
        template_repo_branch: null,
        template_repo_operator_owned: 0,
      },
    ])
    expect(
      handle.sqlite
        .prepare('SELECT name FROM kysely_migration ORDER BY name')
        .all()
        .map((row) => (row as { name: string }).name),
    ).toEqual(['0001_initial_schema', '0002_legacy_ratings_schema', '0003_season_template_branch'])
    await handle.storage.close()
  })

  it.each([
    ['no columns', false, false],
    ['the branch column', true, false],
    ['the ownership column', false, true],
    ['both columns', true, true],
  ] as const)('upgrades a version 2 database that already has %s', async (_name, branch, ownership) => {
    const path = databasePath()
    writeVersion2Seasons(path)
    const interrupted = new BetterSqlite3(path)
    if (branch) {
      interrupted.exec(`
        ALTER TABLE seasons ADD COLUMN template_repo_branch TEXT;
        UPDATE seasons SET template_repo_branch = 'class/spring';
      `)
    }
    if (ownership) {
      interrupted.exec(`
        ALTER TABLE seasons ADD COLUMN template_repo_operator_owned INTEGER NOT NULL DEFAULT 0;
        UPDATE seasons SET template_repo_operator_owned = 1;
      `)
    }
    interrupted.close()

    // Reopening a completed upgrade must preserve the same data as its first successful startup.
    for (let attempt = 0; attempt < 2; attempt++) {
      const handle = await openSqlite(path)
      try {
        expect(handle.sqlite.pragma('user_version', { simple: true })).toBe(APPROVED_SCHEMA_VERSION)
        expect(await handle.storage.getSeason('operator-season')).toEqual({
          id: 'operator-season',
          env_id: 'flappy_bird',
          submission_status: 'closed',
          play_status: 'open',
          release_status: 'unreleased',
          label: 'Spring class',
          description_markdown: 'Class assignment',
          template_repo_url: 'https://example.test/template',
          template_repo_branch: branch ? 'class/spring' : null,
          template_repo_operator_owned: 1,
          config: '{"deps_version":1,"matches":[],"overrides":{}}',
          rating_prompt: 'How did it fly?',
          created_at: '2026-06-01T00:00:00.000Z',
          released_at: null,
          template_source: null,
        })
      } finally {
        await handle.storage.close()
      }
    }
  })
})

/**
 * The deployed version 2 season shape, independent of the fresh-database migration. It holds only
 * the tables 0003 touches today, so a new 0003 step on another table must add that table here too.
 */
function writeVersion2Seasons(path: string): void {
  const previous = new BetterSqlite3(path)
  previous.exec(`
    CREATE TABLE seasons (
      id TEXT PRIMARY KEY,
      env_id TEXT NOT NULL,
      submission_status TEXT NOT NULL,
      play_status TEXT NOT NULL,
      release_status TEXT NOT NULL,
      label TEXT,
      description_markdown TEXT,
      template_repo_url TEXT,
      config TEXT NOT NULL,
      rating_prompt TEXT,
      created_at TEXT NOT NULL,
      released_at TEXT,
      template_source TEXT
    );
    INSERT INTO seasons VALUES (
      'operator-season', 'flappy_bird', 'closed', 'open', 'unreleased', 'Spring class',
      'Class assignment', 'https://example.test/template',
      '{"deps_version":1,"matches":[],"overrides":{}}', 'How did it fly?',
      '2026-06-01T00:00:00.000Z', NULL, NULL
    );
    CREATE TABLE kysely_migration (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      timestamp VARCHAR(255) NOT NULL
    );
    INSERT INTO kysely_migration VALUES
      ('0001_initial_schema', '2026-06-01T00:00:00.000Z'),
      ('0002_legacy_ratings_schema', '2026-06-02T00:00:00.000Z');
    CREATE TABLE kysely_migration_lock (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      is_locked INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO kysely_migration_lock VALUES ('migration_lock', 0);
    PRAGMA user_version = 2;
  `)
  previous.close()
}
