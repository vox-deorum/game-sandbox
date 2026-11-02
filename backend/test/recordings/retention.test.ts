import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PinResult,
  Retention,
  type RetentionConfig,
  reclaimOrphanedOfficialTelemetry,
} from '../../src/recordings/retention.js'
import { RecordingsStore } from '../../src/recordings/store.js'
import type {
  NewRecordingInput,
  RecordingCleanupClaimResult,
  Storage,
} from '../../src/storage/index.js'
import { DevelopmentLedgerStore, ExecutionTelemetryStore } from '../../src/storage/llm/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { createRunOrFail } from '../support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from '../support/llm-options.js'

const CALL_CONTENT = {
  model: 'small',
  request: { prompt: 'hello' },
  completion: { text: 'world' },
  inputTokens: 1,
  reasoningTokens: 0,
  outputTokens: 2,
  usageEstimated: false,
  latencyMs: 5,
  createdAt: '2026-06-11T00:00:00.000Z',
}
const OFFICIAL_CALL = {
  ...CALL_CONTENT,
  sessionId: 'session-1',
  player: 'player_0',
  tick: 0,
  costWeight: 1,
  budgetCostUnits: 3,
}

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
  let telemetry: ExecutionTelemetryStore

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
    await mkdir(join(root, 'recordings', id), { recursive: true })
    const header = JSON.stringify({
      schema_version: 1,
      environment: env,
      parameters: { players: 1 },
      players: { player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' } },
      seats: { seat_0: ['player_0'] },
      seat_plan: 'solo',
      seed: 0,
    })
    await writeFile(join(root, 'recordings', id, 'recording.jsonl'), `${header}\n`, 'utf-8')
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

  async function runWithRecording(
    seasonId: string,
    recordingIds: string[],
    status: 'running' | 'completed',
  ) {
    const run = await createRunOrFail(storage, seasonId, 'op', () => ({
      parametersSnapshot: { players: 1 },
      scheduledGames: recordingIds.map((_, game_index) => ({
        match_index: 0,
        game_index,
        seed: game_index + 1,
        seats: [{ kind: 'builtin', name: 'naive' }],
        seat_plan: 'solo',
      })),
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
    const games = await storage.listRunGames(run.id)
    for (const [index, recordingId] of recordingIds.entries()) {
      const game = games[index]
      if (game === undefined) throw new Error('expected a scheduled game')
      await storage.attachRunGameRecording(game.id, recordingId)
    }
    await storage.setRunStatus(run.id, status)
    return run
  }

  async function writeLlmRecording(): Promise<void> {
    telemetry.insert('session-1', OFFICIAL_CALL)
    await writeRecording({
      id: 'recording-1',
      user_id: 'alice',
      env_id: 'flappy_bird',
      created_at: ago(40),
      llm_scope_id: 'session-1',
      llm_session_id: 'session-1',
    })
  }

  async function expectRecordings(ids: string[]): Promise<void> {
    expect((await storage.listRecordings()).map((row) => row.id).sort()).toEqual(ids)
    expect((await recordings.list()).map((recording) => recording.id).sort()).toEqual(ids)
    expect((await readdir(join(root, 'recordings'))).sort()).toEqual(ids)
    expect(await storage.listRecordingCleanupQueue()).toEqual([])
  }

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
    root = mkdtempSync(join(tmpdir(), 'gs-ret-'))
    await mkdir(join(root, 'recordings'))
    recordings = new RecordingsStore(join(root, 'recordings'))
    telemetry = new ExecutionTelemetryStore(join(root, 'llm'))
  })

  afterEach(async () => {
    telemetry.close()
    await storage.close()
    rmSync(root, { recursive: true, force: true })
  })

  describe('sweep: LLM telemetry scopes', () => {
    it('reclaims startup orphans without losing retained official or development calls', async () => {
      const development = new DevelopmentLedgerStore(join(root, 'llm', 'development'))
      try {
        telemetry.insert('retained-scope', OFFICIAL_CALL)
        telemetry.insert('orphan-scope', OFFICIAL_CALL)
        development.record('season-1', { ...CALL_CONTENT, userId: 'alice' })
        await storage.createRecording({
          id: 'retained-recording',
          user_id: 'alice',
          env_id: 'flappy_bird',
          created_at: ago(1),
          llm_scope_id: 'retained-scope',
          llm_session_id: 'session-1',
        })
        await reclaimOrphanedOfficialTelemetry(storage, telemetry)
        telemetry.close()
        development.close()

        expect(existsSync(telemetry.pathForScope('orphan-scope'))).toBe(false)
        expect(telemetry.readAssociatedCalls('retained-scope', 'session-1')).toEqual([
          { id: 1, ...OFFICIAL_CALL },
        ])
        expect(existsSync(development.pathForSeason('season-1'))).toBe(true)
        expect(development.listUserCalls('season-1', 'alice', { limit: 10 })).toEqual({
          calls: [{ id: 1, ...CALL_CONTENT, userId: 'alice' }],
          nextCursor: null,
        })
      } finally {
        development.close()
      }
    })

    it('removes a real telemetry scope only after its final recording is evicted', async () => {
      telemetry.insert('run-1', { ...OFFICIAL_CALL, sessionId: 'g2' })
      for (const [id, days] of [
        ['g1', 40],
        ['g2', 5],
      ] as const) {
        await writeRecording({
          id,
          user_id: 'a',
          env_id: 'flappy_bird',
          created_at: ago(days),
          llm_scope_id: 'run-1',
          llm_session_id: id,
        })
      }
      await writeRecording({
        id: 'plain',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(40),
      })

      await makeRetention({}, telemetry).sweep()
      await expectRecordings(['g2'])
      expect(telemetry.readAssociatedCalls('run-1', 'g2')).toEqual([
        { id: 1, ...OFFICIAL_CALL, sessionId: 'g2' },
      ])

      await makeRetention({ recordingRetentionDays: 1 }, telemetry).sweep()
      expect(existsSync(telemetry.pathForScope('run-1'))).toBe(false)
      await expectRecordings([])
    })

    it('revalidates active and newly protected workflow recordings at the claim boundary', async () => {
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      const run = await runWithRecording(season.id, ['game-1'], 'running')
      await writeRecording({
        id: 'game-1',
        user_id: 'op',
        env_id: 'flappy_bird',
        created_at: ago(3),
      })
      await writeRecording({
        id: 'quota-pressure',
        user_id: 'op',
        env_id: 'flappy_bird',
        created_at: ago(2),
      })

      await makeRetention({ recordingUserQuota: 1 }).sweep()
      await expectRecordings(['game-1', 'quota-pressure'])

      // A stale candidate must be refused even when its sweep began before this run completed.
      await storage.setRunStatus(run.id, 'completed')
      await expect(storage.claimRecordingCleanup('game-1')).resolves.toBe('protected')
      await expectRecordings(['game-1', 'quota-pressure'])
    })

    it.each([
      { stage: 'directory', directoryRemains: true },
      { stage: 'telemetry', directoryRemains: false },
    ])('retries durable $stage cleanup after reopening application storage', async ({
      stage,
      directoryRemains,
    }) => {
      const database = join(root, 'retention.sqlite')
      await storage.close()
      storage = await openSqliteStorage(database)
      await writeLlmRecording()
      const failure =
        stage === 'directory'
          ? vi
              .spyOn(recordings, 'delete')
              .mockRejectedValueOnce(new Error('directory removal failed'))
          : vi.spyOn(telemetry, 'deleteScope').mockImplementationOnce(() => {
              throw new Error('unlink failed')
            })
      try {
        await makeRetention({}, telemetry).sweep()
      } finally {
        failure.mockRestore()
      }
      expect(existsSync(join(root, 'recordings', 'recording-1'))).toBe(directoryRemains)
      expect(await storage.getRecording('recording-1')).toBeUndefined()
      expect(await storage.listRecordingCleanupQueue()).toEqual([
        { recording_id: 'recording-1', llm_scope_id: 'session-1' },
      ])
      telemetry.close()
      await storage.close()
      storage = await openSqliteStorage(database)
      telemetry = new ExecutionTelemetryStore(join(root, 'llm'))
      expect(await storage.listRecordingCleanupQueue()).toEqual([
        { recording_id: 'recording-1', llm_scope_id: 'session-1' },
      ])
      expect(telemetry.readAssociatedCalls('session-1', 'session-1')).toEqual([
        { id: 1, ...OFFICIAL_CALL },
      ])

      await makeRetention(
        { recordingRetentionDays: 3650, recordingUserQuota: 100 },
        telemetry,
      ).sweep()
      expect(existsSync(telemetry.pathForScope('session-1'))).toBe(false)
      await expectRecordings([])
    })

    it('retains an active live scope until the session becomes terminal', async () => {
      await storage.createSession({
        id: 'session-1',
        user_id: 'alice',
        env_id: 'flappy_bird',
        parameters: { players: 1 },
        mode: 'human',
        recording_id: 'recording-1',
        created_at: ago(40),
      })
      await writeLlmRecording()
      for (const status of ['starting', 'running']) {
        if (status === 'running') await storage.markRunning('session-1')
        await expect(storage.claimRecordingCleanup('recording-1')).resolves.toBe('active_scope')
        expect(await storage.getRecording('recording-1')).toBeDefined()
        expect(await recordings.exists('recording-1')).toBe(true)
        expect(await storage.listRecordingCleanupQueue()).toEqual([])
      }
      expect(telemetry.readAssociatedCalls('session-1', 'session-1')).toEqual([
        { id: 1, ...OFFICIAL_CALL },
      ])

      await storage.markEnded('session-1', 'terminated', ago(1))
      await makeRetention({}, telemetry).sweep()
      expect(existsSync(telemetry.pathForScope('session-1'))).toBe(false)
      await expectRecordings([])
    })
  })

  it.each([
    'pin-first',
    'claim-first',
    'concurrent',
  ] as const)('preserves a consistent pin and cleanup outcome: %s', async (order) => {
    await writeRecording({ id: 'r', user_id: 'alice', env_id: 'flappy_bird', created_at: ago(40) })
    const retention = makeRetention()
    const pin = () => retention.pin('r', 'alice')
    const claim = () => storage.claimRecordingCleanup('r')
    let pinResult: PinResult
    let claimResult: RecordingCleanupClaimResult
    if (order === 'pin-first') {
      pinResult = await pin()
      claimResult = await claim()
    } else if (order === 'claim-first') {
      claimResult = await claim()
      pinResult = await pin()
    } else {
      ;[claimResult, pinResult] = await Promise.all([claim(), pin()])
    }
    const pinWins = { claim: 'pinned', pin: { ok: true }, pinned: 1, queue: [] }
    const claimWins = {
      claim: 'claimed',
      pin: { ok: false, reason: 'not_found' },
      pinned: undefined,
      queue: [{ recording_id: 'r', llm_scope_id: null }],
    }
    const allowed =
      order === 'pin-first'
        ? [pinWins]
        : order === 'claim-first'
          ? [claimWins]
          : [pinWins, claimWins]
    expect(allowed).toContainEqual({
      claim: claimResult,
      pin: pinResult,
      pinned: (await storage.getRecording('r'))?.pinned,
      queue: await storage.listRecordingCleanupQueue(),
    })
    await retention.unpin('r', 'alice')
    await retention.sweep()
    await expectRecordings([])
  })

  describe('sweep: window', () => {
    it('evicts expired unpinned rows, including missing directories, and retains recent rows and pins', async () => {
      for (const [id, days, pinned] of [
        ['old', 40, false],
        ['new', 5, false],
        ['pin', 90, true],
      ] as const) {
        await writeRecording({
          id,
          user_id: 'a',
          env_id: 'flappy_bird',
          created_at: ago(days),
          pinned,
        })
      }
      await storage.createRecording({
        id: 'missing-dir',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(99),
      })
      await makeRetention().sweep()
      await expectRecordings(['new', 'pin'])
    })
  })

  describe('sweep: quota', () => {
    it('counts pins and evicts oldest unpinned recordings within each user quota', async () => {
      for (const [id, user, days, pinned] of [
        ['a-pin', 'a', 9, true],
        ['a-new', 'a', 1, false],
        ['b-old', 'b', 3, false],
        ['a-old', 'a', 4, false],
        ['a-middle', 'a', 2, false],
        ['b-new', 'b', 1, false],
      ] as const) {
        await writeRecording({
          id,
          user_id: user,
          env_id: 'flappy_bird',
          created_at: ago(days),
          pinned,
        })
      }
      await makeRetention({ recordingUserQuota: 2 }).sweep()
      await expectRecordings(['a-new', 'a-pin', 'b-new', 'b-old'])
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
  })

  describe('sweep: leaderboard protection', () => {
    it.each([
      'released',
      'unreleased',
    ] as const)('exempts the current %s board from age and quota while reclaiming superseded and expired live recordings', async (release) => {
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      await storage.setReleaseStatus(season.id, release)
      for (const [id, days] of [
        ['lb-superseded', 90],
        ['lb-current-old', 90],
        ['lb-current-new', 1],
        ['live-old', 40],
        ['live-new', 5],
      ] as const) {
        await writeRecording({ id, user_id: 'op', env_id: 'flappy_bird', created_at: ago(days) })
      }
      await runWithRecording(season.id, ['lb-superseded'], 'completed')
      await runWithRecording(season.id, ['lb-current-old', 'lb-current-new'], 'completed')

      await makeRetention({ recordingUserQuota: 1 }).sweep()
      await expectRecordings(['lb-current-new', 'lb-current-old', 'live-new'])
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
        failed_player: null,
        termination_detail: null,
        season_id: null,
      })
    })

    it('carries the crash attribution from whichever row supplied the reason', async () => {
      await writeRecording({ id: 'live', user_id: 'a', env_id: 'flappy_bird', created_at: ago(1) })
      await storage.createSession({
        id: 'sess-crashed',
        user_id: 'a',
        env_id: 'flappy_bird',
        parameters: { players: 1 },
        mode: 'scripted',
        recording_id: 'live',
        created_at: ago(1),
      })
      await storage.markEnded('sess-crashed', 'error', ago(1), {
        failed_player: 'player_0',
        termination_detail: 'RuntimeError: boom (agent.py:4 in act)',
      })
      await writeRecording({
        id: 'automated-crash',
        user_id: 'a',
        env_id: 'flappy_bird',
        created_at: ago(2),
        termination_reason: 'error',
        failed_player: null,
        termination_detail: 'ValueError: bad layout (env.py:12 in step)',
      })

      const byId = new Map((await makeRetention().list()).map((r) => [r.id, r]))
      expect(byId.get('live')).toMatchObject({
        termination_reason: 'error',
        failed_player: 'player_0',
        termination_detail: 'RuntimeError: boom (agent.py:4 in act)',
        winner_id: null,
      })
      expect(byId.get('automated-crash')).toMatchObject({
        termination_reason: 'error',
        failed_player: null,
        termination_detail: 'ValueError: bad layout (env.py:12 in step)',
      })
    })

    it('lists a tournament game recording under its run’s season', async () => {
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      const run = await createRunOrFail(storage, season.id, 'op', () => ({
        parametersSnapshot: { players: 1 },
        scheduledGames: [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
        llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
      }))
      const game = (await storage.listRunGames(run.id))[0]
      if (game === undefined) {
        throw new Error('expected a scheduled game')
      }
      await storage.attachRunGameRecording(game.id, 'tournament')
      await writeRecording({
        id: 'tournament',
        user_id: 'op',
        env_id: 'flappy_bird',
        created_at: ago(1),
        termination_reason: 'terminated',
      })

      const byId = new Map((await makeRetention().list()).map((r) => [r.id, r]))
      // No session claims it, so the season comes from the run the game belongs to.
      expect(byId.get('tournament')).toMatchObject({ season_id: season.id })
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
