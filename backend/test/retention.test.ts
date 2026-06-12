import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'
import { Migrator } from 'kysely/migration'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RecordingsStore } from '../src/recordings.js'
import { Retention, type RetentionConfig } from '../src/retention.js'
import { LiveSession } from '../src/session/live-session.js'
import type { NewRecordingInput, Storage } from '../src/storage/index.js'
import { migrationProvider } from '../src/storage/migrations/index.js'
import type { Database } from '../src/storage/schema.js'
import { openSqliteStorage } from '../src/storage/sqlite.js'
import { FakeSessionProcess } from './support/fake-driver.js'
import { flush } from './support/harness.js'

const DAY = 86_400_000
// A fixed "now" so window math is deterministic; created_at values are offsets back from it.
const NOW = Date.parse('2026-06-12T00:00:00.000Z')
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()

const DEFAULTS: RetentionConfig = {
  recordingRetentionDays: 30,
  recordingUserQuota: 100,
  recordingSweepIntervalMs: 3_600_000,
}

describe('retention', () => {
  let storage: Storage
  let root: string
  let recordings: RecordingsStore

  function makeRetention(overrides: Partial<RetentionConfig> = {}): Retention {
    return new Retention(
      storage,
      recordings,
      { ...DEFAULTS, ...overrides },
      () => {},
      () => NOW,
    )
  }

  /** Write a recording directory (a header line is enough for the volume listing to find it). */
  async function writeDir(id: string, env = 'flappy_bird'): Promise<void> {
    await mkdir(join(root, id), { recursive: true })
    const header = JSON.stringify({ schema_version: 1, environment: env, seed: 0 })
    await writeFile(join(root, id, 'recording.jsonl'), `${header}\n`, 'utf-8')
  }

  /** Write both the directory and the retention row, the normal post-finalize state. */
  async function writeRecording(
    input: NewRecordingInput & { pinned?: boolean; env?: string },
  ): Promise<void> {
    const { pinned, env, ...row } = input
    await writeDir(row.id, env ?? row.env_id)
    await storage.createRecording(row)
    if (pinned) {
      await storage.setRecordingPinned(row.id, true)
    }
  }

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
    root = mkdtempSync(join(tmpdir(), 'gs-ret-'))
    recordings = new RecordingsStore(root)
  })

  afterEach(async () => {
    await storage.close()
    rmSync(root, { recursive: true, force: true })
  })

  describe('finalize writes the recordings row', () => {
    it('records a row when a session finalizes', async () => {
      await storage.createSession({
        id: 'sess-1',
        user_id: 'alice',
        env_id: 'flappy_bird',
        mode: 'human',
        recording_id: 'flappy_bird-sess-1',
        created_at: ago(0),
      })
      const session = new LiveSession({
        id: 'sess-1',
        userId: 'alice',
        envId: 'flappy_bird',
        mode: 'human',
        recordingId: 'flappy_bird-sess-1',
        createdAt: ago(0),
        process: new FakeSessionProcess(),
        humanSlots: ['player_0'],
        deps: {
          storage,
          onEnd: () => {},
          log: () => {},
          idleTimeoutMs: 1_000_000,
          maxDurationMs: 1_000_000,
          killGraceMs: 10,
        },
      })
      await session.finalize('stopped')
      await flush()
      expect(await storage.getRecording('flappy_bird-sess-1')).toMatchObject({
        id: 'flappy_bird-sess-1',
        user_id: 'alice',
        env_id: 'flappy_bird',
        pinned: 0,
      })
    })
  })

  describe('migration backfill', () => {
    it('backfills a recordings row from each pre-existing session that produced a recording', async () => {
      // The real upgrade path: migration 001 has already run and sessions exist; then migration 002
      // runs and backfills. Drive the migrator to 001, insert sessions, then migrate to latest.
      const sqlite = new BetterSqlite3(':memory:')
      const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) })
      const migrator = new Migrator({ db, provider: migrationProvider })
      const toFirst = await migrator.migrateTo('001_create_sessions')
      expect(toFirst.error).toBeUndefined()

      await db
        .insertInto('sessions')
        .values([
          {
            id: 's1',
            user_id: 'alice',
            env_id: 'flappy_bird',
            mode: 'human',
            status: 'ended',
            termination_reason: 'stopped',
            recording_id: 'flappy_bird-s1',
            created_at: ago(2),
            ended_at: ago(2),
          },
          {
            // A session that never produced a recording must not be backfilled.
            id: 's2',
            user_id: 'bob',
            env_id: 'flappy_bird',
            mode: 'human',
            status: 'ended',
            termination_reason: 'error',
            recording_id: null,
            created_at: ago(2),
            ended_at: ago(2),
          },
        ])
        .execute()

      const toLatest = await migrator.migrateToLatest()
      expect(toLatest.error).toBeUndefined()

      const rows = await db.selectFrom('recordings').selectAll().execute()
      expect(rows).toEqual([
        {
          id: 'flappy_bird-s1',
          user_id: 'alice',
          env_id: 'flappy_bird',
          created_at: ago(2),
          pinned: 0,
        },
      ])
      await db.destroy()
    })
  })

  describe('sweep: window', () => {
    it('evicts an unpinned recording older than the window and keeps a recent one', async () => {
      await writeRecording({ id: 'old', user_id: 'a', env_id: 'flappy_bird', created_at: ago(40) })
      await writeRecording({ id: 'new', user_id: 'a', env_id: 'flappy_bird', created_at: ago(5) })
      await makeRetention().sweep()
      expect(await storage.getRecording('old')).toBeUndefined()
      expect(await storage.getRecording('new')).toBeDefined()
      expect(await recordings.exists('old')).toBe(false)
      expect(await recordings.exists('new')).toBe(true)
    })

    it('never evicts a pinned recording past the window', async () => {
      await writeRecording({
        id: 'pin',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(90),
        pinned: true,
      })
      await makeRetention().sweep()
      expect(await storage.getRecording('pin')).toBeDefined()
      expect(await recordings.exists('pin')).toBe(true)
    })
  })

  describe('sweep: quota', () => {
    it('evicts oldest-unpinned-first until the user is back within quota', async () => {
      for (const [id, days] of [
        ['r1', 4],
        ['r2', 3],
        ['r3', 2],
        ['r4', 1],
      ] as const) {
        await writeRecording({ id, user_id: 'a', env_id: 'flappy_bird', created_at: ago(days) })
      }
      await makeRetention({ recordingUserQuota: 2 }).sweep()
      // The two oldest go; the two newest survive.
      expect(await storage.getRecording('r1')).toBeUndefined()
      expect(await storage.getRecording('r2')).toBeUndefined()
      expect(await storage.getRecording('r3')).toBeDefined()
      expect(await storage.getRecording('r4')).toBeDefined()
    })

    it('keeps users independent for the quota', async () => {
      await writeRecording({ id: 'a1', user_id: 'a', env_id: 'flappy_bird', created_at: ago(3) })
      await writeRecording({ id: 'a2', user_id: 'a', env_id: 'flappy_bird', created_at: ago(2) })
      await writeRecording({ id: 'b1', user_id: 'b', env_id: 'flappy_bird', created_at: ago(3) })
      await makeRetention({ recordingUserQuota: 1 }).sweep()
      expect(await storage.getRecording('a1')).toBeUndefined()
      expect(await storage.getRecording('a2')).toBeDefined()
      expect(await storage.getRecording('b1')).toBeDefined()
    })

    it('a pinned recording survives a quota sweep that evicts its unpinned neighbor', async () => {
      await writeRecording({
        id: 'pinned',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(9),
        pinned: true,
      })
      await writeRecording({
        id: 'unpinned',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(1),
      })
      // Quota 1: the user is over by one (pinned counts), so the lone unpinned recording is evicted.
      await makeRetention({ recordingUserQuota: 1 }).sweep()
      expect(await storage.getRecording('pinned')).toBeDefined()
      expect(await storage.getRecording('unpinned')).toBeUndefined()
    })
  })

  describe('sweep: debris and crash tolerance', () => {
    it('ignores a directory with no retention row', async () => {
      await writeDir('orphan-dir')
      await makeRetention().sweep()
      // Never evicted; still listed header-only.
      expect(await recordings.exists('orphan-dir')).toBe(true)
      const listed = await makeRetention().list()
      expect(listed.find((r) => r.id === 'orphan-dir')).toMatchObject({
        user_id: null,
        created_at: null,
        pinned: false,
      })
    })

    it('tolerates a row whose directory is already gone', async () => {
      // A row with no directory (a crash deleted the dir but not the row): the next sweep removes
      // the row without throwing.
      await storage.createRecording({
        id: 'rowless-dir',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(99),
      })
      await expect(makeRetention().sweep()).resolves.toBeUndefined()
      expect(await storage.getRecording('rowless-dir')).toBeUndefined()
    })
  })

  describe('list: merge and filter', () => {
    it('merges headers with rows, filters on env, and orders newest first', async () => {
      await writeRecording({
        id: 'fb-old',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(3),
      })
      await writeRecording({
        id: 'fb-new',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(1),
      })
      await writeRecording({
        id: 'other',
        user_id: 'a',
        env_id: 'other_env',
        env: 'other_env',
        created_at: ago(2),
      })

      const all = await makeRetention().list()
      expect(all.map((r) => r.id)).toEqual(['fb-new', 'other', 'fb-old'])
      expect(all[0]).toMatchObject({ user_id: 'a', created_at: ago(1), pinned: false })

      const onlyFlappy = await makeRetention().list({ env: 'flappy_bird' })
      expect(onlyFlappy.map((r) => r.id)).toEqual(['fb-new', 'fb-old'])
    })
  })

  describe('pinning', () => {
    beforeEach(async () => {
      await writeRecording({ id: 'r', user_id: 'alice', env_id: 'flappy_bird', created_at: ago(1) })
    })

    it('pins and unpins owner-only', async () => {
      expect(await makeRetention().pin('r', 'bob')).toEqual({ ok: false, reason: 'forbidden' })
      expect(await makeRetention().pin('r', 'alice')).toEqual({ ok: true })
      expect((await storage.getRecording('r'))?.pinned).toBe(1)

      expect(await makeRetention().unpin('r', 'bob')).toEqual({ ok: false, reason: 'forbidden' })
      expect(await makeRetention().unpin('r', 'alice')).toEqual({ ok: true })
      expect((await storage.getRecording('r'))?.pinned).toBe(0)
    })

    it('404s an unknown recording', async () => {
      expect(await makeRetention().pin('nope', 'alice')).toEqual({ ok: false, reason: 'not_found' })
    })

    it('refuses a pin once the user is at their pinned quota', async () => {
      await writeRecording({
        id: 'p1',
        user_id: 'alice',
        env_id: 'flappy_bird',
        created_at: ago(3),
        pinned: true,
      })
      await writeRecording({
        id: 'p2',
        user_id: 'alice',
        env_id: 'flappy_bird',
        created_at: ago(2),
        pinned: true,
      })
      const retention = makeRetention({ recordingUserQuota: 2 })
      expect(await retention.pin('r', 'alice')).toEqual({ ok: false, reason: 'pinned_quota' })
      expect((await storage.getRecording('r'))?.pinned).toBe(0)
    })
  })
})
