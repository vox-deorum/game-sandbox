import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Retention,
  type RetentionConfig,
  reclaimOrphanedOfficialTelemetry,
} from '../../src/recordings/retention.js'
import { RecordingsStore } from '../../src/recordings/store.js'
import type { NewRecordingInput, ScheduledGameInput, Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore, ExecutionTelemetryStore } from '../../src/storage/llm/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { createRunOrFail } from '../support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from '../support/llm-options.js'

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

  function makeRetention(
    overrides: Partial<RetentionConfig> = {},
    llmTelemetry?: { deleteScope(scopeId: string): void },
  ): Retention {
    return new Retention(
      storage,
      recordings,
      { ...DEFAULTS, ...overrides },
      () => NOW,
      llmTelemetry,
    )
  }

  /** Write a recording directory (a header line is enough for the volume listing to find it). */
  async function writeDir(id: string, env = 'flappy_bird'): Promise<void> {
    await mkdir(join(root, id), { recursive: true })
    const header = JSON.stringify({
      schema_version: 1,
      environment: env,
      parameters: { players: 1 },
      players: { player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' } },
      seats: { seat_0: ['player_0'] },
      seat_plan: 'solo',
      seed: 0,
    })
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

  describe('sweep: LLM telemetry scopes', () => {
    it('reclaims startup official orphans while preserving references and development ledgers', async () => {
      const telemetryRoot = mkdtempSync(join(tmpdir(), 'gs-startup-telemetry-'))
      const telemetry = new ExecutionTelemetryStore(telemetryRoot)
      const development = new DevelopmentLedgerStore(join(telemetryRoot, 'development'))
      try {
        telemetry.open('retained-scope')
        telemetry.open('orphan-scope')
        development.open('season-1')
        await storage.createRecording({
          id: 'retained-recording',
          user_id: 'alice',
          env_id: 'flappy_bird',
          created_at: ago(1),
          llm_scope_id: 'retained-scope',
          llm_session_id: 'session-1',
        })

        await reclaimOrphanedOfficialTelemetry(storage, telemetry)

        expect(existsSync(telemetry.pathForScope('retained-scope'))).toBe(true)
        expect(existsSync(telemetry.pathForScope('orphan-scope'))).toBe(false)
        expect(existsSync(development.pathForSeason('season-1'))).toBe(true)
        expect(telemetry.listCalls('retained-scope')).toEqual([])
      } finally {
        development.close()
        telemetry.close()
        rmSync(telemetryRoot, { recursive: true, force: true })
      }
    })

    it('deletes a telemetry scope only with the last recording that references it', async () => {
      const deleted: string[] = []
      const reclaimer = { deleteScope: (id: string) => deleted.push(id) }
      // Two games of one workflow run share the scope; a plain recording has none.
      await writeRecording({
        id: 'g1',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(40),
        llm_scope_id: 'run-1',
        llm_session_id: 'g1',
      })
      await writeRecording({
        id: 'g2',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(5),
        llm_scope_id: 'run-1',
        llm_session_id: 'g2',
      })
      await writeRecording({
        id: 'plain',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(40),
      })

      // First sweep evicts g1 and plain; g2 still references the scope, so the file survives.
      await makeRetention({}, reclaimer).sweep()
      expect(await storage.getRecording('g1')).toBeUndefined()
      expect(await storage.getRecording('g2')).toBeDefined()
      expect(deleted).toEqual([])

      // Tightening the window evicts g2, the last reference, and the scope goes with it.
      await makeRetention({ recordingRetentionDays: 1 }, reclaimer).sweep()
      expect(await storage.getRecording('g2')).toBeUndefined()
      expect(deleted).toEqual(['run-1'])
    })

    it('revalidates active and protected workflow recordings before claiming cleanup', async () => {
      const deleted: string[] = []
      const reclaimer = { deleteScope: (id: string) => deleted.push(id) }
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      const run = await createRunOrFail(storage, season.id, 'operator', () => ({
        parametersSnapshot: { players: 1 },
        scheduledGames: [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
          {
            match_index: 0,
            game_index: 1,
            seed: 2,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
        llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
      }))
      const game = (await storage.listRunGames(run.id))[0]
      if (game === undefined) throw new Error('expected a scheduled game')
      await storage.setRunStatus(run.id, 'running')
      await storage.attachRunGameRecording(game.id, 'game-1')
      await writeRecording({
        id: 'game-1',
        user_id: 'operator',
        env_id: 'flappy_bird',
        created_at: ago(3),
      })
      await writeRecording({
        id: 'quota-pressure',
        user_id: 'operator',
        env_id: 'flappy_bird',
        created_at: ago(2),
      })

      // This disabled-policy recording has no LLM scope, matching production. The transactional
      // claim still sees its active workflow association, so neither replay nor metadata is removed.
      const retention = makeRetention({ recordingUserQuota: 1 }, reclaimer)
      await retention.sweep()
      expect(await recordings.exists('game-1')).toBe(true)
      expect(await storage.getRecording('game-1')).toBeDefined()
      expect(await storage.listRecordingCleanupQueue()).toEqual([])
      expect(deleted).toEqual([])

      // This direct claim represents a sweep whose protected-id snapshot went stale while it was
      // paused. The database boundary sees the newly completed latest run and refuses cleanup.
      await storage.setRunStatus(run.id, 'completed')
      await expect(storage.claimRecordingCleanup('game-1')).resolves.toBe('protected')
      expect(await recordings.exists('game-1')).toBe(true)
      expect(await storage.getRecording('game-1')).toBeDefined()
      expect(await storage.listRecordingCleanupQueue()).toEqual([])
      expect(deleted).toEqual([])
    })

    it('retries claimed telemetry cleanup independently from recording state', async () => {
      let attempts = 0
      const reclaimer = {
        deleteScope: () => {
          attempts += 1
          if (attempts === 1) {
            throw new Error('unlink failed')
          }
        },
      }
      await storage.createSession({
        id: 'ended-session',
        user_id: 'alice',
        env_id: 'flappy_bird',
        parameters: { players: 1 },
        mode: 'human',
        recording_id: 'ended-recording',
        created_at: ago(40),
      })
      await storage.markEnded('ended-session', 'terminated', ago(39))
      await writeRecording({
        id: 'ended-recording',
        user_id: 'alice',
        env_id: 'flappy_bird',
        created_at: ago(40),
        llm_scope_id: 'ended-session',
        llm_session_id: 'ended-session',
      })

      const retention = makeRetention({}, reclaimer)
      await retention.sweep()
      expect(await recordings.exists('ended-recording')).toBe(false)
      expect(await storage.getRecording('ended-recording')).toBeUndefined()
      expect(await storage.listRecordingCleanupQueue()).toEqual([
        { recording_id: 'ended-recording', llm_scope_id: 'ended-session' },
      ])
      expect(attempts).toBe(1)

      await retention.sweep()
      expect(await storage.getRecording('ended-recording')).toBeUndefined()
      expect(await storage.listRecordingCleanupQueue()).toEqual([])
      expect(attempts).toBe(2)
    })
  })

  it('orders pin updates atomically against cleanup claims', async () => {
    const retention = makeRetention()
    for (let index = 0; index < 20; index++) {
      const id = `pin-claim-${index}`
      const userId = `owner-${index}`
      await writeRecording({ id, user_id: userId, env_id: 'flappy_bird', created_at: ago(40) })

      const [claim, pin] = await Promise.all([
        storage.claimRecordingCleanup(id),
        retention.pin(id, userId),
      ])
      if (pin.ok) {
        expect(claim).toBe('pinned')
        expect(await storage.getRecording(id)).toMatchObject({ pinned: 1 })
        await storage.setRecordingPinned(id, false)
        await expect(storage.claimRecordingCleanup(id)).resolves.toBe('claimed')
      } else {
        expect(pin.reason).toBe('not_found')
        expect(claim).toBe('claimed')
        expect(await storage.getRecording(id)).toBeUndefined()
      }
      await storage.completeRecordingCleanup(id)
    }
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

  describe('sweep: leaderboard protection', () => {
    const NAIVE_GAME: ScheduledGameInput[] = [
      {
        match_index: 0,
        game_index: 0,
        seed: 1,
        seats: [{ kind: 'builtin', name: 'naive' }],
        seat_plan: 'solo',
      },
    ]

    /** Drive a completed run for a season whose single game points at a recording id. */
    async function completedRunWithRecording(seasonId: string, recordingId: string): Promise<void> {
      const run = await createRunOrFail(storage, seasonId, 'op', () => ({
        parametersSnapshot: { players: 1 },
        scheduledGames: NAIVE_GAME,
        llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
      }))
      const game = (await storage.listRunGames(run.id))[0]
      if (game === undefined) {
        throw new Error('expected a scheduled game')
      }
      await storage.attachRunGameRecording(game.id, recordingId)
      await storage.setRunStatus(run.id, 'completed')
    }

    it('exempts the current run, reclaims a superseded run, leaves live sessions on the window', async () => {
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      // An earlier completed run (superseded) and the latest completed run, both old enough that the
      // window would evict their recordings if they were not leaderboard-protected.
      await writeRecording({
        id: 'lb-superseded',
        user_id: 'op',
        env_id: 'flappy_bird',
        created_at: ago(90),
      })
      await completedRunWithRecording(season.id, 'lb-superseded')
      await writeRecording({
        id: 'lb-current',
        user_id: 'op',
        env_id: 'flappy_bird',
        created_at: ago(90),
      })
      await completedRunWithRecording(season.id, 'lb-current')
      // Live-session recordings: one past the window, one inside it.
      await writeRecording({
        id: 'live-old',
        user_id: 'op',
        env_id: 'flappy_bird',
        created_at: ago(40),
      })
      await writeRecording({
        id: 'live-new',
        user_id: 'op',
        env_id: 'flappy_bird',
        created_at: ago(5),
      })

      await makeRetention().sweep()

      expect(await storage.getRecording('lb-current')).toBeDefined() // protected, survives the window
      expect(await storage.getRecording('lb-superseded')).toBeUndefined() // superseded, reclaimable
      expect(await storage.getRecording('live-old')).toBeUndefined() // live window evicts it
      expect(await storage.getRecording('live-new')).toBeDefined()
    })

    it('a protected leaderboard recording does not count toward the owner quota', async () => {
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      await writeRecording({ id: 'lb', user_id: 'op', env_id: 'flappy_bird', created_at: ago(1) })
      await completedRunWithRecording(season.id, 'lb')
      await writeRecording({ id: 'live', user_id: 'op', env_id: 'flappy_bird', created_at: ago(1) })

      // Quota 1: if the protected recording counted, the owner would be over quota and the live
      // recording would be evicted. It is filtered out before the quota pass, so the live one survives.
      await makeRetention({ recordingUserQuota: 1 }).sweep()
      expect(await storage.getRecording('lb')).toBeDefined()
      expect(await storage.getRecording('live')).toBeDefined()
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

    it('surfaces the producing session’s termination reason and season, null when none claims it', async () => {
      // One recording produced by an ended session, one rowless of a session (debris, never ended).
      await writeRecording({ id: 'ended', user_id: 'a', env_id: 'flappy_bird', created_at: ago(1) })
      await writeRecording({
        id: 'orphan',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(2),
      })
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      await storage.createSession({
        id: 'sess-ended',
        user_id: 'a',
        env_id: 'flappy_bird',
        parameters: { players: 1 },
        mode: 'human',
        recording_id: 'ended',
        season_id: season.id,
        created_at: ago(1),
      })
      await storage.markEnded('sess-ended', 'idle_timeout', ago(1))

      const byId = new Map((await makeRetention().list()).map((r) => [r.id, r]))
      expect(byId.get('ended')).toMatchObject({
        termination_reason: 'idle_timeout',
        season_id: season.id,
      })
      // A rowless directory has no claiming session, so both joined fields are null.
      expect(byId.get('orphan')).toMatchObject({ termination_reason: null, season_id: null })
    })

    it('falls back to the recording row’s own reason for an automated run with no session', async () => {
      // An automated season run produces a recording with no producing session, so its row carries the
      // termination reason itself. The listing surfaces it (no session reason exists to override it).
      await writeRecording({
        id: 'automated',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(1),
        termination_reason: 'terminated',
      })

      const byId = new Map((await makeRetention().list()).map((r) => [r.id, r]))
      // No session claims it, so season stays null, but the row's own reason is surfaced.
      expect(byId.get('automated')).toMatchObject({
        termination_reason: 'terminated',
        season_id: null,
      })
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
