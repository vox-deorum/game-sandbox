import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthUser } from '../../src/auth/identity.js'
import type { UserDirectory } from '../../src/auth/users.js'
import { EnvironmentRegistry } from '../../src/environments/registry.js'
import { ensureRecordingsDir } from '../../src/session/live-session.js'
import type { IssueOfficialGrantsInput } from '../../src/session/official-grants.js'
import {
  Orchestrator,
  OrchestratorError,
  type SeatAssignment,
  type StartRequest,
} from '../../src/session/orchestrator.js'
import type { Storage, Submission } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import type {
  ResolvedSource,
  SourceInput,
  SubmissionSource,
  TreeHandle,
} from '../../src/submission/source/index.js'
import { FakeDriver, type FakeSessionProcess } from '../support/fake-driver.js'
import { delay, FakeSocket, flush, makeConfig, makeEnvironments, meta } from '../support/harness.js'

/** A resolved signed-in caller for attach, matched against the session owner by id. */
function caller(id: string): AuthUser {
  return {
    id,
    name: id,
    email: `${id}@test.local`,
    image: null,
    githubUsername: null,
    status: 'normal',
  }
}

/**
 * A submission-source double for the submitted-agent runs. Records the inputs it resolves and
 * fetches, and tracks whether the materialized tree was disposed, so a test can assert the overlay
 * (or composed session image) rebuild path refetched the pinned source and cleaned up its checkout.
 */
class FakeSource implements SubmissionSource {
  readonly resolved: SourceInput[] = []
  fetchCount = 0
  disposed = 0

  verifyReachable(): Promise<never> {
    throw new Error('not used in orchestrator tests')
  }
  resolve(input: SourceInput): Promise<ResolvedSource> {
    this.resolved.push(input)
    return Promise.resolve({
      kind: input.kind,
      repoUrl: input.kind === 'git' ? input.repoUrl : null,
      commitSha: input.kind === 'git' ? 'sha123' : null,
      ref: input.kind === 'git' ? input.ref : null,
      resolvedRef: null,
      localPath: input.kind === 'local' ? input.localPath : null,
    })
  }
  fetchTree(): Promise<TreeHandle> {
    this.fetchCount += 1
    return Promise.resolve({
      path: '/tmp/fake-tree',
      dispose: () => {
        this.disposed += 1
        return Promise.resolve()
      },
    })
  }
}

/** Seed a `ready` submission for `userId` on the env's open season. */
async function seedReadySubmission(
  storage: Storage,
  userId = 'eve',
  envId = 'flappy_bird',
): Promise<Submission> {
  const season = await storage.ensureOpenSeason(envId, 1)
  const submission = await storage.createSubmission({
    season_id: season.id,
    env_id: envId,
    user_id: userId,
    source_kind: 'git',
    repo_url: 'https://example.test/agent',
    commit_sha: 'sha123',
    local_path: null,
    ref: null,
    created_at: new Date().toISOString(),
  })
  await storage.updateSubmissionStatus(submission.id, 'ready')
  return submission
}

/** Sugar for a single-seat assignment, the shape most start tests need. */
function seats(assignment: SeatAssignment): Record<string, SeatAssignment> {
  return { seat_0: assignment }
}

/** A canned {@link UserDirectory} over a fixed id → display-name map; unmapped ids stay absent. */
function stubDirectory(names: Record<string, string>): UserDirectory {
  return {
    namesFor: (ids) =>
      Promise.resolve(
        new Map(ids.flatMap((id) => (names[id] === undefined ? [] : [[id, names[id]] as const]))),
      ),
    profilesFor: (ids) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id) =>
            names[id] === undefined ? [] : [[id, { name: names[id] }] as const],
          ),
        ),
      ),
  }
}

/** A four-seat Hearts assignment defaulting to built-in agents, overridable per seat. */
function heartsSeats(
  overrides: Record<string, SeatAssignment> = {},
): Record<string, SeatAssignment> {
  return {
    seat_0: { kind: 'builtin-agent', name: 'naive' },
    seat_1: { kind: 'builtin-agent', name: 'naive' },
    seat_2: { kind: 'builtin-agent', name: 'naive' },
    seat_3: { kind: 'builtin-agent', name: 'naive' },
    ...overrides,
  }
}

/** A full start request with class defaults (alice, flappy_bird, one built-in seat), overridable. */
function startRequest(overrides: Partial<StartRequest> = {}): StartRequest {
  const envId = overrides.envId ?? 'flappy_bird'
  return {
    userId: 'alice',
    envId,
    seasonId: PLAY_SEASONS.get(envId) ?? 'missing',
    parameters:
      envId === 'hearts' || envId === 'chatty' ? { players: 4 } : { players: 1, pipe_gap: 100 },
    seats: seats({ kind: 'builtin-agent', name: 'naive' }),
    ...overrides,
  }
}

const HEADER = JSON.stringify({
  schema_version: 1,
  environment: 'flappy_bird',
  parameters: { players: 1, pipe_gap: 100 },
  players: { player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' } },
  seats: { seat_0: ['player_0'] },
  seat_plan: 'solo',
  seed: 0,
})
const STATE = '{"schema_version":1,"tick":0,"agents":{},"timing":{"started_at":1,"duration_ms":1}}'
const PLAY_SEASONS = new Map<string, string>()
const WIDE_ENV_ID = 'synthetic_wide'

/** A registry fixture whose noncontiguous wide seat exercises expansion without changing production metadata. */
function wideEnvironments(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      ...makeEnvironments().list(),
      meta({
        env_id: WIDE_ENV_ID,
        display_name: 'Synthetic wide',
        description: 'A four-player synthetic layout for orchestrator tests.',
        builtin_agents: [
          { name: 'naive', label: 'Naive agent' },
          { name: 'scripted_hero', label: 'Scripted hero' },
        ],
        layout: {
          kind: 'seat_plans',
          plans: [
            {
              key: 'uneven',
              title: 'Uneven',
              seats: [{ players: [0, 2, 3] }, { players: [1] }],
            },
            {
              key: 'restricted',
              title: 'Restricted',
              seats: [
                { players: [0, 2, 3], restricted_builtin: 'scripted_hero' },
                { players: [1] },
              ],
            },
            {
              key: 'partially_human',
              title: 'Partially human',
              seats: [{ players: [0, 1] }, { players: [2, 3] }],
            },
          ],
        },
        human_players: ['player_0', 'player_2', 'player_3'],
        human_timeout_ms: 5_000,
        recommended_episode_ticks: 10,
        pace_interval_ms: null,
        llm: true,
        renderer: 'fake',
        seat_order_matters: true,
        parameters: [
          {
            name: 'seat_plan',
            title: 'Seat plan',
            description: 'Seat-to-player layout for each game.',
            type: 'choice',
            default: 'uneven',
            choices: [
              { value: 'uneven', label: 'Uneven' },
              { value: 'restricted', label: 'Restricted' },
              { value: 'partially_human', label: 'Partially human' },
            ],
          },
        ],
      }),
    ]),
    'synthetic-wide-test',
  )
}

/** Flush the finalize chain (kill → markEnded → notify) across its several awaits. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flush()
  }
}

describe('orchestrator', () => {
  let storage: Storage
  let driver: FakeDriver
  let recordingsDir: string

  function makeOrchestrator(
    idleMs = 60_000,
    source?: SubmissionSource,
    userDirectory?: UserDirectory,
    configOverrides: Parameters<typeof makeConfig>[0] = {},
  ): Orchestrator {
    const config = makeConfig({ recordingsDir, sessionIdleTimeoutMs: idleMs, ...configOverrides })
    // Pair an (empty) snapshot store with the source whenever one is supplied: the rebuild path tries
    // the snapshot first, finds none here, and falls back to the source seam exactly as before.
    const snapshots =
      source === undefined
        ? undefined
        : new SubmissionSnapshotStore(join(recordingsDir, 'submissions'))
    return new Orchestrator({
      driver,
      storage,
      environments: makeEnvironments(),
      config,
      submissionSource: source,
      submissionSnapshots: snapshots,
      userDirectory,
    })
  }

  function makeWideOrchestrator(
    source: SubmissionSource,
    onIssue: (input: IssueOfficialGrantsInput) => void,
  ): Orchestrator {
    const config = makeConfig({ recordingsDir, dataDir: recordingsDir })
    return new Orchestrator({
      driver,
      storage,
      environments: wideEnvironments(),
      config,
      submissionSource: source,
      submissionSnapshots: new SubmissionSnapshotStore(join(recordingsDir, 'submissions')),
      resolveLiveLlm: () => ({
        enabled: true,
        models: { small: { upstream: 'upstream-small', costWeight: 1 } },
        official: { tokenBudget: 1_000, requestsPerMinute: 5 },
        development: { tokenBudget: 2_000, requestsPerMinute: 10 },
      }),
      officialGrantIssuer: {
        issue: (input) => {
          onIssue(input)
          return Promise.resolve({
            keys: Object.fromEntries(
              input.agentPlayers.map((playerId) => [playerId, `key-${playerId}`]),
            ),
            revoke: () => Promise.resolve(),
          })
        },
      },
    })
  }

  async function start(
    orch: Orchestrator,
    overrides: Partial<StartRequest> = {},
  ): Promise<{ id: string; process: FakeSessionProcess; config: Record<string, unknown> }> {
    const result = await orch.start(startRequest(overrides))
    const launch = driver.lastLaunch()
    if (launch === undefined) {
      throw new Error('no launch recorded')
    }
    return {
      id: result.id,
      process: launch.process,
      config: JSON.parse(launch.spec.argv[0] ?? '{}'),
    }
  }

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
    driver = new FakeDriver()
    recordingsDir = mkdtempSync(join(tmpdir(), 'gs-orch-'))
    // A plain public session needs a play-open season to attach to (the seed season is both
    // submission- and play-open); seed it for the environments the plain-session tests exercise.
    PLAY_SEASONS.clear()
    for (const envId of ['flappy_bird', 'simultaneous', 'turn_based', 'hearts', 'chatty']) {
      const season = await storage.ensureOpenSeason(envId, 1)
      PLAY_SEASONS.set(envId, season.id)
    }
  })

  /** Set the play-open season's messaging override for a messaging env, so start() resolves it. */
  async function setMessagingOverride(
    envId: string,
    messaging: { enabled?: boolean; message_cap?: number },
  ): Promise<void> {
    const season = await storage.getPublicPlaySeason(envId)
    if (season === undefined) {
      throw new Error(`no play-open season for ${envId}`)
    }
    await storage.updateSeasonConfig(season.id, {
      deps_version: 1,
      matches: [],
      overrides: { messaging },
    })
  }

  afterEach(async () => {
    vi.useRealTimers()
    await storage.close()
    rmSync(recordingsDir, { recursive: true, force: true })
  })

  describe('start', () => {
    it('uses the deployment override', async () => {
      vi.useFakeTimers()
      const orch = makeOrchestrator(1_000_000, undefined, undefined, { sessionMaxDurationMs: 10 })
      const { process } = await start(orch, {})

      await vi.advanceTimersByTimeAsync(9)
      expect(process.killGraceMs).toEqual([])

      await vi.advanceTimersByTimeAsync(1)
      expect(process.killGraceMs).toEqual([5_000])
    })

    it('issues keys only for agent players and emits the exact live LLM launch block', async () => {
      const config = makeConfig({ recordingsDir, dataDir: recordingsDir })
      let issued: IssueOfficialGrantsInput | undefined
      const orch = new Orchestrator({
        driver,
        storage,
        environments: makeEnvironments(),
        config,
        resolveLiveLlm: () => ({
          enabled: true,
          models: { small: { upstream: 'upstream-small', costWeight: 1 } },
          official: { tokenBudget: 1000, requestsPerMinute: 5 },
          development: { tokenBudget: 2000, requestsPerMinute: 10 },
        }),
        officialGrantIssuer: {
          issue: (input) => {
            issued = input
            return Promise.resolve({
              keys: Object.fromEntries(
                input.agentPlayers.map((playerId) => [playerId, `key-${playerId}`]),
              ),
              revoke: () => Promise.resolve(),
            })
          },
        },
      })

      const launched = await start(orch, {
        envId: 'hearts',
        seats: heartsSeats({ seat_0: { kind: 'human' } }),
      })
      expect(issued?.agentPlayers).toEqual(['player_1', 'player_2', 'player_3'])
      // The keys themselves leave the container argv; only the mount path travels in the config.
      expect(launched.config.llm).toEqual({
        base_url: `http://llm-proxy:${config.llm.internalPort}/v1`,
        tick_url: `http://llm-proxy:${config.llm.internalPort}/internal/tick`,
        inflight_url: `http://llm-proxy:${config.llm.internalPort}/internal/inflight`,
        keys_file: '/run/llm-keys.json',
      })
      expect(driver.lastLaunch()?.spec.sandbox.network).toBe('llm')
      expect(driver.lastLaunch()?.spec.sandbox.mounts).toContainEqual(
        expect.objectContaining({ containerPath: '/run/llm-keys.json', readOnly: true }),
      )
      expect(await storage.getSession(launched.id)).toMatchObject({ llm_enabled: 1 })
      const keysPath = join(config.dataDir, 'llm-keys', `${launched.id}.json`)
      await expect(stat(keysPath)).resolves.toBeDefined()
      await orch.stop(launched.id, 'alice')
      // Stopping the session tears the lease down and removes the staged keys file.
      await expect(stat(keysPath)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('revokes the issued lease when staging the keys file fails', async () => {
      // A dataDir leaf that is a file makes the keys-file write fail deterministically, after the
      // official lease has already been issued — the write failure must not strand a live grant.
      const blocker = join(recordingsDir, 'keys-blocker')
      writeFileSync(blocker, 'occupied')
      const config = makeConfig({ recordingsDir, dataDir: blocker })
      let revoked = 0
      const orch = new Orchestrator({
        driver,
        storage,
        environments: makeEnvironments(),
        config,
        resolveLiveLlm: () => ({
          enabled: true,
          models: { small: { upstream: 'upstream-small', costWeight: 1 } },
          official: { tokenBudget: 1_000, requestsPerMinute: 5 },
          development: { tokenBudget: 2_000, requestsPerMinute: 10 },
        }),
        officialGrantIssuer: {
          issue: (input) =>
            Promise.resolve({
              keys: Object.fromEntries(
                input.agentPlayers.map((playerId) => [playerId, `key-${playerId}`]),
              ),
              revoke: () => {
                revoked += 1
                return Promise.resolve()
              },
            }),
        },
      })

      await expect(orch.start(startRequest())).rejects.toThrow(
        /failed to issue official LLM grants/,
      )
      // The lease was issued but its keys could not be staged: revoke it so a chargeable official
      // grant is not left outstanding on a session that never launched.
      expect(revoked).toBe(1)
      // No session row and no container: the failure happened before either.
      expect(await storage.listSessions()).toEqual([])
      expect(driver.lastLaunch()).toBeUndefined()
    })

    it('revokes the lease and removes the staged keys file when the session row fails to insert', async () => {
      const config = makeConfig({ recordingsDir, dataDir: recordingsDir })
      let sessionId: string | undefined
      let revoked = 0
      const orch = new Orchestrator({
        driver,
        storage,
        environments: makeEnvironments(),
        config,
        resolveLiveLlm: () => ({
          enabled: true,
          models: { small: { upstream: 'upstream-small', costWeight: 1 } },
          official: { tokenBudget: 1_000, requestsPerMinute: 5 },
          development: { tokenBudget: 2_000, requestsPerMinute: 10 },
        }),
        officialGrantIssuer: {
          issue: (input) => {
            sessionId = input.sessionId
            return Promise.resolve({
              keys: Object.fromEntries(
                input.agentPlayers.map((playerId) => [playerId, `key-${playerId}`]),
              ),
              revoke: () => {
                revoked += 1
                return Promise.resolve()
              },
            })
          },
        },
      })
      // A durable-write failure after the keys file was staged must tear the lease down and remove
      // the staged key file, not leave either behind.
      const createSession = vi.spyOn(storage, 'createSession')
      createSession.mockRejectedValue(new Error('durable write failed'))

      await expect(orch.start(startRequest())).rejects.toThrow(/durable write failed/)
      expect(revoked).toBe(1)
      const keysPath = join(config.dataDir, 'llm-keys', `${sessionId}.json`)
      await expect(stat(keysPath)).rejects.toMatchObject({ code: 'ENOENT' })
      createSession.mockRestore()
    })

    it('inserts a starting row and launches with the sandbox profile and config argv', async () => {
      const orch = makeOrchestrator()
      const { id, config } = await start(orch, { seats: seats({ kind: 'human' }), seed: 42 })

      const row = await storage.getSession(id)
      expect(row).toMatchObject({
        id,
        user_id: 'alice',
        env_id: 'flappy_bird',
        // A human seat makes the derived mode `human`.
        mode: 'human',
        status: 'starting',
        recording_id: `flappy_bird-${id}`,
      })

      const launch = driver.lastLaunch()
      expect(launch?.spec.sessionId).toBe(id)
      expect(launch?.spec.image.ref).toContain('session-base')
      expect(launch?.spec.sandbox).toMatchObject({
        cpus: 1,
        memoryMb: 512,
        readOnlyRoot: true,
        network: 'none',
        scratch: { containerPath: '/tmp', sizeMb: 256 },
        pids: 512,
      })
      expect(launch?.spec.sandbox.mounts).toEqual([
        {
          // Each session mounts only its own recordings directory (per-session isolation).
          hostPath: join(recordingsDir, 'sessions', id),
          containerPath: '/recordings',
          readOnly: false,
        },
      ])
      expect(config).toMatchObject({
        env_id: 'flappy_bird',
        seed: 42,
        player_bindings: { player_0: { kind: 'external' } },
        start_paused: true,
        recording_dir: '/recordings',
        recording_id: `flappy_bird-${id}`,
      })
      // The human player is attributed to the session owner in the recording header.
      expect(config.players).toEqual({
        player_0: { kind: 'human', label: 'alice', user: 'alice' },
      })
    })

    it('binds the built-in agent for a scripted (watch) session', async () => {
      const { config } = await start(makeOrchestrator(), {
        seats: seats({ kind: 'builtin-agent', name: 'naive' }),
      })
      expect(config.player_bindings).toEqual({ player_0: { kind: 'builtin-agent', name: 'naive' } })
      expect(config.start_paused).toBe(false)
      // A plain watch run attributes the player to the built-in Naive agent.
      expect(config.players).toEqual({
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      })
    })

    it('rejects an undeclared built-in agent before launching a session', async () => {
      const orch = makeOrchestrator()
      await expect(
        orch.start(startRequest({ seats: seats({ kind: 'builtin-agent', name: 'unknown' }) })),
      ).rejects.toMatchObject({
        status: 400,
        message: 'unknown built-in agent unknown for environment flappy_bird',
      })
      expect(driver.launches).toHaveLength(0)
    })

    it('derives scripted mode for an all-agent session', async () => {
      const { id } = await start(makeOrchestrator())
      expect((await storage.getSession(id))?.mode).toBe('scripted')
    })

    it('prepares the recording volume for the cap-dropped session container', async () => {
      const nested = join(recordingsDir, 'nested')
      await ensureRecordingsDir(nested)
      if (process.platform !== 'win32') {
        expect(statSync(nested).mode & 0o777).toBe(0o777)
      }
    })

    it('resolves the human timeout: override wins, else metadata, else null', async () => {
      const orch1 = makeOrchestrator()
      const a = await start(orch1, {
        envId: 'turn_based',
        seats: seats({ kind: 'human' }),
        humanTimeoutMs: 2000,
      })
      expect(a.config.human_timeout_ms).toBe(2000)

      driver = new FakeDriver()
      const orch2 = makeOrchestrator()
      const b = await start(orch2, { envId: 'turn_based', seats: seats({ kind: 'human' }) })
      expect(b.config.human_timeout_ms).toBe(5000)

      driver = new FakeDriver()
      const orch3 = makeOrchestrator()
      const c = await start(orch3, { envId: 'flappy_bird', seats: seats({ kind: 'human' }) })
      expect(c.config.human_timeout_ms).toBeNull()
    })

    it('rejects a simultaneous human timeout before it creates a session or launches a container', async () => {
      const orch = makeOrchestrator()

      await expect(
        start(orch, {
          envId: 'simultaneous',
          seats: seats({ kind: 'human' }),
          humanTimeoutMs: 2000,
        }),
      ).rejects.toMatchObject({ status: 400, code: 'human_timeout_not_allowed' })

      expect(driver.launches).toHaveLength(0)
      expect(await storage.listSessions()).toEqual([])
    })

    it('omits the human timeout from a simultaneous launch config', async () => {
      const result = await start(makeOrchestrator(), {
        envId: 'simultaneous',
        seats: seats({ kind: 'human' }),
      })

      expect(result.config).not.toHaveProperty('human_timeout_ms')
    })

    it('rejects a second concurrent session for the same user with 409', async () => {
      const orch = makeOrchestrator()
      await start(orch)
      await expect(orch.start(startRequest())).rejects.toMatchObject({ status: 409 })
    })

    it('lets a different user start concurrently', async () => {
      const orch = makeOrchestrator()
      await start(orch, { userId: 'alice' })
      await expect(orch.start(startRequest({ userId: 'bob' }))).resolves.toBeDefined()
    })

    it('refuses a plain public session when no season is open for public play', async () => {
      const orch = makeOrchestrator()
      // Close the seeded play window: a Naive watch or human play run now has no season to attach to.
      const season = await storage.getPublicPlaySeason('flappy_bird')
      await storage.setPlayStatus(season?.id ?? '', 'closed')
      await expect(orch.start(startRequest())).rejects.toMatchObject({
        status: 409,
        code: 'no_play_open_season',
      })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects a stale season id and parameter maps that do not exactly match the declaration', async () => {
      const orch = makeOrchestrator()
      await expect(orch.start(startRequest({ seasonId: 'stale-season' }))).rejects.toMatchObject({
        status: 409,
        code: 'play_season_changed',
      })
      await expect(orch.start(startRequest({ parameters: {} }))).rejects.toMatchObject({
        status: 400,
        code: 'invalid_parameters',
      })
      await expect(
        orch.start(startRequest({ parameters: { players: 1, extra: 'no' } })),
      ).rejects.toMatchObject({
        status: 400,
        code: 'invalid_parameters',
      })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects an unknown environment and a human in a non-human-capable seat', async () => {
      const orch = makeOrchestrator()
      await expect(orch.start(startRequest({ userId: 'a', envId: 'nope' }))).rejects.toMatchObject({
        status: 400,
      })
      // watch_only marks no player human-capable, so a human assignment there is rejected.
      const watchOnlySeason = await storage.ensureOpenSeason('watch_only', 1)
      PLAY_SEASONS.set('watch_only', watchOnlySeason.id)
      await expect(
        orch.start(
          startRequest({ userId: 'c', envId: 'watch_only', seats: seats({ kind: 'human' }) }),
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })
  })

  describe('synthetic wide-seat start', () => {
    it('stages one submitted wide seat and expands independent player bindings and grants', async () => {
      const source = new FakeSource()
      let issued: IssueOfficialGrantsInput | undefined
      const orch = makeWideOrchestrator(source, (input) => {
        issued = input
      })
      const submission = await seedReadySubmission(storage, 'eve', WIDE_ENV_ID)
      const season = await storage.ensureOpenSeason(WIDE_ENV_ID, 1)

      const result = await orch.start({
        userId: 'alice',
        envId: WIDE_ENV_ID,
        seasonId: season.id,
        parameters: { seat_plan: 'uneven' },
        seats: {
          seat_0: { kind: 'submission', submissionId: submission.id },
          seat_1: { kind: 'builtin-agent', name: 'naive' },
        },
      })

      const launch = driver.lastLaunch()
      const launchConfig = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        player_bindings: Record<string, unknown>
        players: Record<string, unknown>
        llm: { keys_file?: string }
      }
      expect(launchConfig.player_bindings).toEqual({
        player_0: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_2: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_3: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_1: { kind: 'builtin-agent', name: 'naive' },
      })
      expect(launchConfig.players).toEqual({
        player_0: {
          kind: 'agent',
          label: "eve's agent",
          user: 'eve',
          submission_id: submission.id,
        },
        player_2: {
          kind: 'agent',
          label: "eve's agent",
          user: 'eve',
          submission_id: submission.id,
        },
        player_3: {
          kind: 'agent',
          label: "eve's agent",
          user: 'eve',
          submission_id: submission.id,
        },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      })
      expect(issued?.agentPlayers).toEqual(['player_0', 'player_2', 'player_3', 'player_1'])
      // Official keys are handed to the harness out-of-band through a read-only mounted file; the
      // session config argv carries only the mount path, never the key material.
      expect(launchConfig.llm.keys_file).toBe('/run/llm-keys.json')
      expect(launchConfig.llm).not.toHaveProperty('keys')
      expect(launch?.spec.sandbox.memoryMb).toBe(608)
      expect(launch?.spec.sandbox.mounts).toContainEqual(
        expect.objectContaining({ containerPath: '/run/llm-keys.json', readOnly: true }),
      )
      expect(source.fetchCount).toBe(1)
      expect(source.disposed).toBe(1)
      expect(
        driver.imageRequests.find((request) => request.kind === 'submission-overlay'),
      ).toMatchObject({ submissionId: submission.id, seatId: 'seat_0' })
      expect(await storage.listSessionSubmissions(result.id)).toMatchObject([
        { submission_id: submission.id, seat_id: 'seat_0' },
      ])
      await orch.stop(result.id, 'alice')
    })

    it('expands a submitted human companion once across the nonhuman members of its seat', async () => {
      const source = new FakeSource()
      let issued: IssueOfficialGrantsInput | undefined
      const orch = makeWideOrchestrator(source, (input) => {
        issued = input
      })
      const companion = await seedReadySubmission(storage, 'eve', WIDE_ENV_ID)
      const season = await storage.ensureOpenSeason(WIDE_ENV_ID, 1)

      const result = await orch.start({
        userId: 'alice',
        envId: WIDE_ENV_ID,
        seasonId: season.id,
        parameters: { seat_plan: 'uneven' },
        seats: {
          seat_0: {
            kind: 'human',
            companion: { kind: 'submission', submissionId: companion.id },
          },
          seat_1: { kind: 'builtin-agent', name: 'naive' },
        },
      })

      const launch = driver.lastLaunch()
      const launchConfig = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        player_bindings: Record<string, unknown>
        players: Record<string, unknown>
        llm: { keys_file?: string }
      }
      expect(launchConfig.player_bindings).toEqual({
        player_0: { kind: 'external' },
        player_2: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_3: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_1: { kind: 'builtin-agent', name: 'naive' },
      })
      expect(launchConfig.players).toEqual({
        player_0: { kind: 'human', label: 'alice', user: 'alice' },
        player_2: {
          kind: 'agent',
          label: "eve's agent",
          user: 'eve',
          submission_id: companion.id,
        },
        player_3: {
          kind: 'agent',
          label: "eve's agent",
          user: 'eve',
          submission_id: companion.id,
        },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      })
      expect(issued?.agentPlayers).toEqual(['player_2', 'player_3', 'player_1'])
      expect(launchConfig.llm.keys_file).toBe('/run/llm-keys.json')
      expect(launchConfig.llm).not.toHaveProperty('keys')
      expect(launch?.spec.sandbox.memoryMb).toBe(608)
      expect(source.fetchCount).toBe(1)
      expect(source.disposed).toBe(1)
      expect(await storage.listSessionSubmissions(result.id)).toMatchObject([
        { submission_id: companion.id, seat_id: 'seat_0' },
      ])
      await orch.stop(result.id, 'alice')
    })

    it('expands a self-controlled wide seat into human players with one chat sender', async () => {
      const source = new FakeSource()
      let issued: IssueOfficialGrantsInput | undefined
      const orch = makeWideOrchestrator(source, (input) => {
        issued = input
      })
      const season = await storage.ensureOpenSeason(WIDE_ENV_ID, 1)

      const { id, config } = await start(orch, {
        envId: WIDE_ENV_ID,
        seasonId: season.id,
        parameters: { seat_plan: 'uneven' },
        seats: {
          seat_0: { kind: 'human', companion: { kind: 'self' } },
          seat_1: { kind: 'builtin-agent', name: 'naive' },
        },
      })

      expect(config.player_bindings).toEqual({
        player_0: { kind: 'external' },
        player_2: { kind: 'external' },
        player_3: { kind: 'external' },
        player_1: { kind: 'builtin-agent', name: 'naive' },
      })
      expect(config.players).toEqual({
        player_0: { kind: 'human', label: 'alice', user: 'alice' },
        player_2: { kind: 'human', label: 'alice', user: 'alice' },
        player_3: { kind: 'human', label: 'alice', user: 'alice' },
        player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      })
      expect(config.external_chat_player).toBe('player_0')
      expect(issued?.agentPlayers).toEqual(['player_1'])
      expect((config.llm as { keys_file?: string }).keys_file).toBe('/run/llm-keys.json')
      expect(config.llm as object).not.toHaveProperty('keys')
      await orch.stop(id, 'alice')
    })

    it('enforces the designated builtin on a restricted seat before session launch', async () => {
      const source = new FakeSource()
      const orch = makeWideOrchestrator(source, () => undefined)
      const submission = await seedReadySubmission(storage, 'eve', WIDE_ENV_ID)
      const season = await storage.getPublicPlaySeason(WIDE_ENV_ID)
      if (season === undefined) throw new Error('synthetic wide season was not created')
      const startRestricted = (seat_0: SeatAssignment): Promise<{ id: string; wsPath: string }> =>
        orch.start({
          userId: 'alice',
          envId: WIDE_ENV_ID,
          seasonId: season.id,
          parameters: { seat_plan: 'restricted' },
          seats: { seat_0, seat_1: { kind: 'builtin-agent', name: 'naive' } },
        })

      await expect(startRestricted({ kind: 'builtin-agent', name: 'naive' })).rejects.toMatchObject(
        {
          status: 400,
          message: expect.stringContaining('only accepts a human or built-in agent scripted_hero'),
        },
      )
      await expect(
        startRestricted({ kind: 'submission', submissionId: submission.id }),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)

      const result = await startRestricted({ kind: 'builtin-agent', name: 'scripted_hero' })
      const launch = driver.lastLaunch()
      const config = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        player_bindings: Record<string, unknown>
      }
      expect(config.player_bindings).toMatchObject({
        player_0: { kind: 'builtin-agent', name: 'scripted_hero' },
        player_2: { kind: 'builtin-agent', name: 'scripted_hero' },
        player_3: { kind: 'builtin-agent', name: 'scripted_hero' },
      })
      await orch.stop(result.id, 'alice')
    })

    it('derives restricted human companions and rejects a client companion or undeclared ordinary companion', async () => {
      const source = new FakeSource()
      let issued: IssueOfficialGrantsInput | undefined
      const orch = makeWideOrchestrator(source, (input) => {
        issued = input
      })
      const season = await storage.ensureOpenSeason(WIDE_ENV_ID, 1)
      const base = {
        userId: 'alice',
        envId: WIDE_ENV_ID,
        seasonId: season.id,
      }

      await expect(
        orch.start({
          ...base,
          parameters: { seat_plan: 'restricted' },
          seats: {
            seat_0: { kind: 'human', companion: { kind: 'builtin-agent', name: 'naive' } },
            seat_1: { kind: 'builtin-agent', name: 'naive' },
          },
        }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('derives') })
      await expect(
        orch.start({
          ...base,
          parameters: { seat_plan: 'restricted' },
          seats: {
            seat_0: { kind: 'human', companion: { kind: 'self' } },
            seat_1: { kind: 'builtin-agent', name: 'naive' },
          },
        }),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('derives') })
      await expect(
        orch.start({
          ...base,
          parameters: { seat_plan: 'uneven' },
          seats: {
            seat_0: { kind: 'human', companion: { kind: 'builtin-agent', name: 'unknown' } },
            seat_1: { kind: 'builtin-agent', name: 'naive' },
          },
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('unknown built-in agent'),
      })
      expect(driver.launches).toHaveLength(0)

      const result = await orch.start({
        ...base,
        parameters: { seat_plan: 'restricted' },
        seats: {
          seat_0: { kind: 'human' },
          seat_1: { kind: 'builtin-agent', name: 'naive' },
        },
      })
      const launch = driver.lastLaunch()
      const config = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        player_bindings: Record<string, unknown>
        players: Record<string, unknown>
      }
      expect(config.player_bindings).toEqual({
        player_0: { kind: 'external' },
        player_2: { kind: 'builtin-agent', name: 'scripted_hero' },
        player_3: { kind: 'builtin-agent', name: 'scripted_hero' },
        player_1: { kind: 'builtin-agent', name: 'naive' },
      })
      expect(config.players.player_2).toEqual({
        kind: 'agent',
        builtin_name: 'scripted_hero',
        label: 'Scripted hero',
      })
      expect(issued?.agentPlayers).toEqual(['player_2', 'player_3', 'player_1'])
      await orch.stop(result.id, 'alice')
    })

    it('stages the same submission independently when it fills two seats', async () => {
      const source = new FakeSource()
      const orch = makeWideOrchestrator(source, () => undefined)
      const submission = await seedReadySubmission(storage, 'eve', WIDE_ENV_ID)
      const season = await storage.getPublicPlaySeason(WIDE_ENV_ID)
      if (season === undefined) throw new Error('synthetic wide season was not created')

      const result = await orch.start({
        userId: 'alice',
        envId: WIDE_ENV_ID,
        seasonId: season.id,
        parameters: { seat_plan: 'uneven' },
        seats: {
          seat_0: { kind: 'submission', submissionId: submission.id },
          seat_1: { kind: 'submission', submissionId: submission.id },
        },
      })

      const launch = driver.lastLaunch()
      const launchConfig = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        player_bindings: Record<string, unknown>
      }
      expect(launchConfig.player_bindings).toEqual({
        player_0: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_2: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_3: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_1: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_1' },
      })
      expect(
        driver.imageRequests.filter((request) => request.kind === 'session-overlay'),
      ).toMatchObject([
        {
          seats: [
            { seatId: 'seat_0', submissionId: submission.id },
            { seatId: 'seat_1', submissionId: submission.id },
          ],
        },
      ])
      expect(source.fetchCount).toBe(2)
      expect(source.disposed).toBe(2)
      expect(
        (await storage.listSessionSubmissions(result.id))
          .map((link) => ({ seat_id: link.seat_id, submission_id: link.submission_id }))
          .sort((a, b) => a.seat_id.localeCompare(b.seat_id)),
      ).toEqual([
        { seat_id: 'seat_0', submission_id: submission.id },
        { seat_id: 'seat_1', submission_id: submission.id },
      ])
      await orch.stop(result.id, 'alice')
    })
  })

  describe('multi-seat Hearts start', () => {
    /** A Hearts start request built from the four-seat defaults. */
    function startHearts(seats: Record<string, SeatAssignment>): StartRequest {
      return startRequest({
        envId: 'hearts',
        seasonId: PLAY_SEASONS.get('hearts') ?? 'missing',
        parameters: { players: 4 },
        seats,
      })
    }

    it('rejects a payload missing a required seat before any container starts', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        // Only three of the four required seats assigned.
        orch.start(
          startHearts({
            seat_0: { kind: 'builtin-agent', name: 'naive' },
            seat_1: { kind: 'builtin-agent', name: 'naive' },
            seat_2: { kind: 'builtin-agent', name: 'naive' },
          }),
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects an unknown seat id', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        orch.start(startHearts(heartsSeats({ seat_9: { kind: 'builtin-agent', name: 'naive' } }))),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects an unnecessary companion on a singleton seat', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        orch.start(
          startHearts(
            heartsSeats({
              seat_0: { kind: 'human', companion: { kind: 'builtin-agent', name: 'naive' } },
            }),
          ),
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects self control when a wide seat has a non-human-capable member', async () => {
      const orch = makeWideOrchestrator(new FakeSource(), () => undefined)
      const season = await storage.ensureOpenSeason(WIDE_ENV_ID, 1)
      await expect(
        orch.start({
          userId: 'alice',
          envId: WIDE_ENV_ID,
          seasonId: season.id,
          parameters: { seat_plan: 'partially_human' },
          seats: {
            seat_0: { kind: 'human', companion: { kind: 'self' } },
            seat_1: { kind: 'builtin-agent', name: 'naive' },
          },
        }),
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringContaining('members that are not human-controllable'),
      })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects self control on a singleton seat', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        orch.start(
          startHearts(heartsSeats({ seat_0: { kind: 'human', companion: { kind: 'self' } } })),
        ),
      ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('singleton') })
      expect(driver.launches).toHaveLength(0)
    })

    it("rejects more than this stage's single human player", async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        orch.start(
          startHearts(heartsSeats({ seat_0: { kind: 'human' }, seat_1: { kind: 'human' } })),
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects a submission for a different environment', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      // A `ready` Flappy Bird submission cannot fill a Hearts seat.
      const foreign = await seedReadySubmission(storage, 'eve', 'flappy_bird')
      await expect(
        orch.start(
          startHearts(heartsSeats({ seat_0: { kind: 'submission', submissionId: foreign.id } })),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'submission_env_mismatch' })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects a non-ready submission before any container starts', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      const season = await storage.ensureOpenSeason('hearts', 1)
      const pending = await storage.createSubmission({
        season_id: season.id,
        env_id: 'hearts',
        user_id: 'eve',
        source_kind: 'git',
        repo_url: 'https://example.test/agent',
        commit_sha: 'sha123',
        local_path: null,
        ref: null,
        created_at: new Date().toISOString(),
      })
      await expect(
        orch.start(
          startHearts(heartsSeats({ seat_0: { kind: 'submission', submissionId: pending.id } })),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'submission_not_ready' })
      expect(driver.launches).toHaveLength(0)
    })

    it('writes one session_submissions row per submitted seat, with human and built-in only in players', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const subA = await seedReadySubmission(storage, 'eve', 'hearts')
      const subB = await seedReadySubmission(storage, 'frank', 'hearts')

      const result = await orch.start(
        startHearts(
          heartsSeats({
            seat_0: { kind: 'submission', submissionId: subA.id },
            seat_1: { kind: 'submission', submissionId: subB.id },
            seat_3: { kind: 'human' },
          }),
        ),
      )

      // A human seat is present, so the derived mode is `human`, attributed to the Hearts play season.
      const heartsSeason = await storage.getPublicPlaySeason('hearts')
      expect(await storage.getSession(result.id)).toMatchObject({
        mode: 'human',
        season_id: heartsSeason?.id,
      })

      // Exactly one attribution row per submitted seat; the built-in and human seats write none.
      const links = await storage.listSessionSubmissions(result.id)
      expect(
        links
          .map((link) => ({ seat_id: link.seat_id, submission_id: link.submission_id }))
          .sort((x, y) => x.seat_id.localeCompare(y.seat_id)),
      ).toEqual([
        { seat_id: 'seat_0', submission_id: subA.id },
        { seat_id: 'seat_1', submission_id: subB.id },
      ])

      const launch = driver.lastLaunch()
      const config = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        player_bindings: Record<string, unknown>
        players: Record<string, unknown>
      }
      expect(config.player_bindings).toEqual({
        player_0: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
        player_1: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_1' },
        player_2: { kind: 'builtin-agent', name: 'naive' },
        player_3: { kind: 'external' },
      })
      // Built-in and human players are represented only here, never as a link row.
      expect(config.players).toEqual({
        player_0: { kind: 'agent', label: "eve's agent", user: 'eve', submission_id: subA.id },
        player_1: { kind: 'agent', label: "frank's agent", user: 'frank', submission_id: subB.id },
        player_2: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_3: { kind: 'human', label: 'alice', user: 'alice' },
      })
      // The composed session image materialized one tree per submitted player and disposed each.
      expect(source.fetchCount).toBe(2)
      expect(source.disposed).toBe(2)
      expect(launch?.spec.image.ref).toContain('session-overlay')
    })

    it('snapshots display names into the header labels while keeping stable ids', async () => {
      const source = new FakeSource()
      // The directory knows the human (alice) and one owner (eve); frank has no row.
      const orch = makeOrchestrator(
        60_000,
        source,
        stubDirectory({ alice: 'Alice Chen', eve: 'Eve Vee' }),
      )
      const subA = await seedReadySubmission(storage, 'eve', 'hearts')
      const subB = await seedReadySubmission(storage, 'frank', 'hearts')

      await orch.start(
        startHearts(
          heartsSeats({
            seat_0: { kind: 'submission', submissionId: subA.id },
            seat_1: { kind: 'submission', submissionId: subB.id },
            seat_3: { kind: 'human' },
          }),
        ),
      )

      const config = JSON.parse(driver.lastLaunch()?.spec.argv[0] ?? '{}') as {
        players: Record<string, unknown>
      }
      // `user` keeps the stable id everywhere; `label` carries the launch-time display name and
      // falls back to the id exactly where the directory has no row (frank).
      expect(config.players).toEqual({
        player_0: { kind: 'agent', label: "Eve Vee's agent", user: 'eve', submission_id: subA.id },
        player_1: { kind: 'agent', label: "frank's agent", user: 'frank', submission_id: subB.id },
        player_2: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
        player_3: { kind: 'human', label: 'Alice Chen', user: 'alice' },
      })
    })

    it('writes no session_submissions rows when the container fails to launch', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const subA = await seedReadySubmission(storage, 'eve', 'hearts')
      const subB = await seedReadySubmission(storage, 'frank', 'hearts')
      driver.onLaunch = () => {
        throw new Error('container refused to start')
      }

      await expect(
        orch.start(
          startHearts(
            heartsSeats({
              seat_0: { kind: 'submission', submissionId: subA.id },
              seat_1: { kind: 'submission', submissionId: subB.id },
            }),
          ),
        ),
      ).rejects.toThrow(/failed to launch/)

      // The failed session is marked ended, and no submission attribution row was written — a launch
      // that never started must leave no phantom "recent run" on either submitted agent.
      const sessions = await storage.listSessions()
      expect(sessions).toHaveLength(1)
      const failed = sessions[0]
      expect(failed).toMatchObject({ status: 'ended', termination_reason: 'error' })
      expect(await storage.listSessionSubmissions(failed?.id ?? '')).toEqual([])
    })
  })

  describe('submitted-agent watch run', () => {
    /** A single-seat Flappy Bird watch of the given submission. */
    function watch(submissionId: string): StartRequest {
      return startRequest({ seats: seats({ kind: 'submission', submissionId }) })
    }

    it('launches from the submission overlay image and binds the agent player to its path', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const submission = await seedReadySubmission(storage)
      // The build stage already produced the overlay and the eviction sweep exempts it; under the
      // default `reuse` policy the watch run finds the cached image without refetching the source.
      const overlayRef = `game-sandbox/submission-overlay:deps-v1-${submission.id}`
      driver.overlayImages.set(overlayRef, {
        ref: overlayRef,
        kind: 'submission',
        submissionId: submission.id,
        createdAtMs: 1,
      })

      const result = await orch.start(watch(submission.id))

      const launch = driver.lastLaunch()
      expect(launch?.spec.image.ref).toBe(overlayRef)
      const config = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        player_bindings: Record<string, unknown>
        players: Record<string, unknown>
      }
      expect(config.player_bindings).toEqual({
        player_0: { kind: 'builtin-agent', path: '/opt/agents/submissions/seat_0' },
      })
      // The submitted-agent player is attributed to the submission owner ('eve' from the seed helper).
      expect(config.players).toEqual({
        player_0: {
          kind: 'agent',
          label: "eve's agent",
          user: 'eve',
          submission_id: submission.id,
        },
      })
      // The reuse path never touched the source seam.
      expect(source.fetchCount).toBe(0)
      // The session is recorded as scripted and tied to the submission for profile history.
      expect(await storage.getSession(result.id)).toMatchObject({
        mode: 'scripted',
        season_id: submission.season_id,
      })
      // Replay history appears only after finalization registers the produced recording row.
      expect(await storage.listRecordingsBySubmission(submission.id, 10)).toEqual([])
      await storage.createRecording({
        id: `flappy_bird-${result.id}`,
        user_id: 'alice',
        env_id: 'flappy_bird',
        created_at: new Date().toISOString(),
      })
      expect(await storage.listRecordingsBySubmission(submission.id, 10)).toEqual([
        `flappy_bird-${result.id}`,
      ])
    })

    it('rebuilds the overlay from the refetched source when the cached image is gone', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const submission = await seedReadySubmission(storage)
      // No seeded overlay image: the cache was evicted, so the run must refetch and rebuild.

      await orch.start(watch(submission.id))

      expect(source.resolved).toHaveLength(1)
      expect(source.resolved[0]).toMatchObject({
        kind: 'git',
        repoUrl: 'https://example.test/agent',
        ref: 'sha123',
      })
      expect(source.fetchCount).toBe(1)
      expect(source.disposed).toBe(1)
      const overlaySpec = driver.imageRequests.find((spec) => spec.kind === 'submission-overlay')
      expect(overlaySpec).toMatchObject({ submissionId: submission.id, seatId: 'seat_0' })
      const launch = driver.lastLaunch()
      expect(launch?.spec.image.ref).toContain(submission.id)
    })

    it('refuses to run a non-ready submission with 409', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const season = await storage.ensureOpenSeason('flappy_bird', 1)
      const submission = await storage.createSubmission({
        season_id: season.id,
        env_id: 'flappy_bird',
        user_id: 'eve',
        source_kind: 'git',
        repo_url: 'https://example.test/agent',
        commit_sha: null,
        local_path: null,
        ref: null,
        created_at: new Date().toISOString(),
      })
      // Still pending (no ready rollup).
      await expect(orch.start(watch(submission.id))).rejects.toMatchObject({
        status: 409,
        code: 'submission_not_ready',
      })
      expect(driver.launches).toHaveLength(0)
    })

    it('refuses a submission that is not active for the play-open season', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const submission = await seedReadySubmission(storage)
      // Resubmitting supersedes the ready row, so it is no longer the active open-season submission.
      const season = await storage.getPublicPlaySeason('flappy_bird')
      await storage.createSubmission({
        season_id: season?.id ?? '',
        env_id: 'flappy_bird',
        user_id: 'eve',
        source_kind: 'git',
        repo_url: 'https://example.test/agent-2',
        commit_sha: null,
        local_path: null,
        ref: null,
        created_at: new Date().toISOString(),
      })
      await expect(orch.start(watch(submission.id))).rejects.toMatchObject({
        status: 409,
        code: 'submission_not_active',
      })
    })

    it('uses the play-open season when submissions are already open for the next round', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const submission = await seedReadySubmission(storage)
      const playSeason = await storage.getSeason(submission.season_id)
      if (playSeason === undefined) {
        throw new Error('missing play season')
      }
      await storage.setSubmissionStatus(playSeason.id, 'closed')
      const nextSeason = await storage.createSeason({
        env_id: 'flappy_bird',
        deps_version: 1,
      })
      await storage.setSubmissionStatus(nextSeason.id, 'open')

      const overlayRef = `game-sandbox/submission-overlay:deps-v1-${submission.id}`
      driver.overlayImages.set(overlayRef, {
        ref: overlayRef,
        kind: 'submission',
        submissionId: submission.id,
        createdAtMs: 1,
      })

      const result = await orch.start(watch(submission.id))

      expect((await storage.getSession(result.id))?.season_id).toBe(playSeason.id)
    })

    it('404s an unknown submission id', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(orch.start(watch('no-such-id'))).rejects.toMatchObject({ status: 404 })
    })
  })

  describe('teardown reasons', () => {
    it('records the container-reported reason when it ends itself', async () => {
      const orch = makeOrchestrator()
      const { id, process } = await start(orch)
      process.emit(HEADER)
      process.emit(STATE)
      process.emit(
        '{"kind":"result","ticks":1,"reason":"terminated","scores":{},"step_timeouts":{}}',
      )
      await flush()
      process.finish({ code: 0, oomKilled: false })
      await settle()
      expect(await storage.getSession(id)).toMatchObject({
        status: 'ended',
        termination_reason: 'terminated',
      })
    })

    it('reports an OOM kill cleanly', async () => {
      const orch = makeOrchestrator()
      const { id, process } = await start(orch)
      process.emit(HEADER)
      await flush()
      process.oom()
      await settle()
      expect((await storage.getSession(id))?.termination_reason).toBe('oom_killed')
    })

    it('reports a crash (nonzero exit, no result) as an error', async () => {
      const orch = makeOrchestrator()
      const { id, process } = await start(orch)
      process.emit(HEADER)
      await flush()
      process.finish({ code: 1, oomKilled: false })
      await settle()
      expect((await storage.getSession(id))?.termination_reason).toBe('error')
    })

    it('kills an idle session and frees the user', async () => {
      const orch = makeOrchestrator(30)
      const { id, process } = await start(orch)
      process.emit(HEADER)
      await flush()
      await delay(80)
      await settle()
      expect((await storage.getSession(id))?.termination_reason).toBe('idle_timeout')
      expect(process.killGraceMs.length).toBeGreaterThan(0)
      // The user is free to start again.
      await expect(orch.start(startRequest())).resolves.toBeDefined()
    })

    it('marks the row running when the header arrives', async () => {
      const orch = makeOrchestrator()
      const { id, process } = await start(orch)
      process.emit(HEADER)
      await flush()
      expect((await storage.getSession(id))?.status).toBe('running')
    })
  })

  describe('attach', () => {
    it('gives only the owner controls; a stranger and an anonymous socket spectate', async () => {
      const orch = makeOrchestrator()
      // A human-mode session so an owner `input` command is forwarded to the container; the owner is
      // 'alice' (the startRequest default).
      const { id, process } = await start(orch, { seats: seats({ kind: 'human' }) })
      const input = JSON.stringify({ kind: 'input', player: 'player_0', action: 1 })
      const owner = orch.attach(id, new FakeSocket(), caller('alice'))
      process.emit(HEADER)
      await flush()
      owner?.handleMessage('{"kind":"resume"}')
      process.sent.length = 0

      // The same input from the owner, a signed-in stranger, and an anonymous (null) socket.
      owner?.handleMessage(input)
      orch.attach(id, new FakeSocket(), caller('bob'))?.handleMessage(input)
      orch.attach(id, new FakeSocket(), null)?.handleMessage(input)

      // Only the owner drives the session; the stranger's and the anonymous socket's commands drop,
      // so exactly one command crossed into the container.
      expect(process.sent).toHaveLength(1)
    })

    it('returns undefined attaching to an unknown session', () => {
      expect(
        makeOrchestrator().attach('no-such-id', new FakeSocket(), caller('alice')),
      ).toBeUndefined()
    })
  })

  describe('stop and finalize', () => {
    it('stops an owner session gracefully, but a non-owner gets 403', async () => {
      const orch = makeOrchestrator()
      const { id } = await start(orch)
      await expect(orch.stop(id, 'mallory')).rejects.toMatchObject({ status: 403 })
      await orch.stop(id, 'alice')
      await settle()
      expect((await storage.getSession(id))?.termination_reason).toBe('stopped')
    })

    it('404s an unknown session id on stop', async () => {
      await expect(makeOrchestrator().stop('missing', 'alice')).rejects.toMatchObject({
        status: 404,
      })
    })

    it('finalizes exactly once when an exit and an idle timeout race', async () => {
      const orch = makeOrchestrator(10)
      const { id, process } = await start(orch)
      process.emit(HEADER)
      await flush()
      // Race the natural OOM exit against the idle window.
      process.oom()
      await delay(30)
      await settle()
      const row = await storage.getSession(id)
      expect(row?.status).toBe('ended')
      // Whichever claimed first won; the row ended once and the user is free.
      expect(['oom_killed', 'idle_timeout']).toContain(row?.termination_reason)
      await expect(orch.start(startRequest())).resolves.toBeDefined()
    })
  })

  it('exposes OrchestratorError with a status for the HTTP layer to map', async () => {
    const orch = makeOrchestrator()
    const error = await orch.start(startRequest({ envId: 'nope' })).catch((e) => e)
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.status).toBe(400)
  })

  describe('messaging config resolution', () => {
    const chattyRequest = (): Partial<StartRequest> => ({
      envId: 'chatty',
      seats: {
        seat_0: { kind: 'human' },
        seat_1: { kind: 'builtin-agent', name: 'naive' },
        seat_2: { kind: 'builtin-agent', name: 'naive' },
        seat_3: { kind: 'builtin-agent', name: 'naive' },
      },
    })

    it('carries the metadata messaging block into the config and persists it on the row', async () => {
      const orch = makeOrchestrator()
      const { id, config } = await start(orch, chattyRequest())
      expect(config).toMatchObject({
        messaging_enabled: true,
        message_cap: 120,
        external_chat_player: 'player_0',
      })
      // Persisted (SQLite 0/1) so the payload answers identically live and after end.
      expect(await storage.getSession(id)).toMatchObject({ messaging_enabled: 1, message_cap: 120 })
    })

    it('disables and does not cap a session on a non-messaging environment', async () => {
      const orch = makeOrchestrator()
      const { id, config } = await start(orch, { seats: seats({ kind: 'human' }) })
      expect(config).toMatchObject({ messaging_enabled: false, message_cap: null })
      expect(await storage.getSession(id)).toMatchObject({
        messaging_enabled: 0,
        message_cap: null,
      })
    })

    it('lets the season override disable messaging but never enable an opted-out environment', async () => {
      await setMessagingOverride('chatty', { enabled: false })
      await setMessagingOverride('flappy_bird', { enabled: true }) // cannot turn on a false-metadata env
      const orch = makeOrchestrator()

      const chatty = await start(orch, chattyRequest())
      expect(chatty.config).toMatchObject({ messaging_enabled: false })

      const flappy = await start(makeOrchestrator(), { seats: seats({ kind: 'human' }) })
      expect(flappy.config).toMatchObject({ messaging_enabled: false })
    })

    it('takes the minimum of the metadata cap and a tightening season override', async () => {
      await setMessagingOverride('chatty', { message_cap: 80 })
      const orch = makeOrchestrator()
      const { config } = await start(orch, chattyRequest())
      // min(120 metadata, 80 override) = 80; an override can only tighten.
      expect(config).toMatchObject({ messaging_enabled: true, message_cap: 80 })
    })

    it('never loosens the cap above the metadata value', async () => {
      await setMessagingOverride('chatty', { message_cap: 500 })
      const orch = makeOrchestrator()
      const { config } = await start(orch, chattyRequest())
      expect(config).toMatchObject({ message_cap: 120 }) // min(120, 500)
    })

    it('applies the play-open season timeout overrides to live sessions too', async () => {
      const season = await storage.getPublicPlaySeason('chatty')
      await storage.updateSeasonConfig(season?.id ?? '', {
        deps_version: 1,
        matches: [],
        overrides: { step_timeout_ms: 250, episode_timeout_ms: 60_000 },
      })
      const orch = makeOrchestrator()
      const { config } = await start(orch, chattyRequest())
      expect(config).toMatchObject({ step_timeout_ms: 250, episode_timeout_ms: 60_000 })
    })

    it('still serves the persisted messaging block after the session has ended', async () => {
      const orch = makeOrchestrator()
      const { id, process } = await start(orch, chattyRequest())
      process.emit(HEADER)
      process.emit(STATE)
      process.finish({ code: 0, oomKilled: false })
      await settle()
      const row = await storage.getSession(id)
      expect(row).toMatchObject({ status: 'ended', messaging_enabled: 1, message_cap: 120 })
    })
  })
})
