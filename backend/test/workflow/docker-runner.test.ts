/**
 * The Docker-backed workflow runner (Stage 6.4), proven Docker-free against the {@link FakeDriver}.
 *
 * Each test persists a run and its schedule, drives the fake containers by hand — emitting a canned
 * recording stream and a `result` envelope, then finishing with a chosen exit — and asserts the runner
 * loaded the persisted games, executed them in order, wrote the expected `game_results` (scores plus
 * `agent_compute_ms_total`/`acted_tick_count` parsed from the fake timing), attached recording ids,
 * and reached the right terminal state. The attributable-crash, timeout, infrastructure-fault, cancel,
 * and re-run paths each get a test. No Docker, no Python, deterministic.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { UserDirectory } from '../../src/auth/users.js'
import type { ExitInfo } from '../../src/driver/index.js'
import { EnvironmentRegistry } from '../../src/environments.js'
import { forfeitScore } from '../../src/leaderboards/score.js'
import type { ResolvedOfficialLlmPolicy } from '../../src/llm/config.js'
import type {
  IssueOfficialGrantsInput,
  OfficialGrantIssuer,
} from '../../src/session/official-grants.js'
import type {
  AgentRef,
  ScheduledGameInput,
  SeasonRun,
  Storage,
  Submission,
} from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import type { SubmissionSource } from '../../src/submission/source/index.js'
import type { RunEvent, TerminalRunStatus } from '../../src/workflow/runner.js'
import { createWorkflowRunner } from '../../src/workflow/workflow-runner.js'
import llmLaunchConfig from '../fixtures/llm-launch-config.json'
import { FakeDriver, type FakeLaunch, type FakeSessionProcess } from '../support/fake-driver.js'

const ENV_ID = 'flappy_bird'

function disabledLlmPolicy(): ResolvedOfficialLlmPolicy {
  return {
    enabled: false,
    models: {},
    session: { token_budget: 1, call_budget: 1, rate_limit_rpm: 1 },
  }
}

function enabledLlmPolicy(): ResolvedOfficialLlmPolicy {
  return {
    enabled: true,
    models: { small: 'provider-small' },
    session: { token_budget: 100, call_budget: 10, rate_limit_rpm: 10 },
  }
}

/** A field-complete single-slot Flappy registry, like the shared harness but local to this suite. */
function makeEnvironments(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      {
        env_id: ENV_ID,
        display_name: 'Flappy Bird',
        description: 'test env',
        min_slots: 1,
        max_slots: 1,
        human_slots: ['player_0'],
        human_timeout_ms: null,
        recommended_episode_ticks: 1000,
        pace_interval_ms: 50,
        step_limit_ms: 1000,
        episode_limit_ms: 120_000,
        messaging: false,
        message_cap: null,
        llm: false,
        renderer: 'flappy-bird',
        seat_order_matters: false,
        view_interval_ms: null,
        live_interval_ms: null,
      },
    ]),
  )
}

/** A snapshot store rooted at an unused path; the reuse path with a seeded overlay never reads it. */
const unusedSnapshots = new SubmissionSnapshotStore(join(tmpdir(), 'gs-runner-unused-snapshots'))

/** A source seam that throws if touched; the reuse path with a seeded overlay never reaches it. */
const unusedSource: SubmissionSource = {
  verifyReachable: () => {
    throw new Error('source.verifyReachable should not be called')
  },
  resolve: () => {
    throw new Error('source.resolve should not be called')
  },
  fetchTree: () => {
    throw new Error('source.fetchTree should not be called')
  },
}

interface RunnerHandle {
  driver: FakeDriver
  storage: Storage
  runner: ReturnType<typeof createWorkflowRunner>
}

function makeRunner(
  storage: Storage,
  driver = new FakeDriver(),
  options: {
    killGraceMs?: number
    gameWatchdogGraceMs?: number
    userDirectory?: UserDirectory
    officialGrantIssuer?: OfficialGrantIssuer
    llmInternalPort?: number
  } = {},
): RunnerHandle {
  const runner = createWorkflowRunner({
    driver,
    storage,
    environments: makeEnvironments(),
    source: unusedSource,
    snapshots: unusedSnapshots,
    sandbox: { cpus: 1, memoryMb: 512, scratchMb: 256 },
    recordingsDir: './data/recordings',
    imagePolicy: 'reuse',
    ...options,
  })
  return { driver, storage, runner }
}

/** Create a configured season and a pending run with the given schedule; returns the run row. */
async function makeRun(
  storage: Storage,
  schedule: ScheduledGameInput[],
  options: {
    submissions?: AgentRef[]
    overrides?: Record<string, unknown>
    llmPolicy?: ResolvedOfficialLlmPolicy
  } = {},
): Promise<SeasonRun> {
  const season = await storage.createSeason({ env_id: ENV_ID, deps_version: 1, label: null })
  await storage.updateSeasonConfig(season.id, {
    deps_version: 1,
    matches: [{ slots: ['submission'], seeds: [1], games: 1 }],
    ...(options.overrides ? { overrides: options.overrides } : {}),
  })
  return storage.createRunWithSchedule(
    season.id,
    'dev-user',
    options.submissions ?? [],
    schedule,
    () => options.llmPolicy ?? disabledLlmPolicy(),
  )
}

/** One scheduled game's resolved slots, the all-Naive single seat by default. */
function naiveGame(gameIndex: number, seed = 1): ScheduledGameInput {
  return { match_index: 0, game_index: gameIndex, seed, slots: [{ kind: 'builtin-naive' }] }
}

/**
 * Emit a canned recording over the fake process's stdout — a header, `ticks` per-step states each
 * carrying the slot's timing, and the final `result` envelope — then finish with `exit`. Mirrors what
 * the harness's tee store and result envelope put on the protocol stream.
 */
function emitRecording(
  process: FakeSessionProcess,
  config: { seed: number },
  options: {
    slotId?: string
    ticks?: number
    decisionMs?: number
    learnMs?: number
    chatMs?: number
    finalScore?: number
    reason?: string
    exit?: ExitInfo
    omitHeader?: boolean
    /** Emit the recording (header + states) but skip the final `result` envelope, modelling a container
     * that exits without fulfilling its output contract. */
    omitResult?: boolean
    diagnostics?: string[]
    /** Per-seat scores in the result envelope, overriding the default single-seat `{ slotId: finalScore }`. */
    scores?: Record<string, number>
    /** The seat the harness pins a crash or budget overage to, carried in the result envelope. */
    failedSlot?: string
  } = {},
): void {
  const slotId = options.slotId ?? 'player_0'
  const ticks = options.ticks ?? 3
  const decisionMs = options.decisionMs ?? 10
  const learnMs = options.learnMs
  const chatMs = options.chatMs
  const finalScore = options.finalScore ?? ticks
  const reason = options.reason ?? 'terminated'
  for (const line of options.diagnostics ?? []) {
    process.emitDiagnostic(line)
  }
  if (options.omitHeader !== true) {
    process.emit(
      JSON.stringify({
        schema_version: 1,
        environment: ENV_ID,
        seed: config.seed,
        created_at: '2026-06-16T00:00:00.000Z',
      }),
    )
    for (let tick = 0; tick < ticks; tick++) {
      const score = ((tick + 1) / ticks) * finalScore
      process.emit(
        JSON.stringify({
          schema_version: 1,
          tick,
          agents: {
            [slotId]: {
              reward: 1,
              score,
              timing: {
                decision_ms: decisionMs,
                ...(learnMs !== undefined ? { learn_ms: learnMs } : {}),
                ...(chatMs !== undefined ? { chat_ms: chatMs } : {}),
              },
            },
          },
          timing: { started_at: tick, duration_ms: decisionMs },
        }),
      )
    }
    if (options.omitResult !== true) {
      process.emit(
        JSON.stringify({
          kind: 'result',
          ticks,
          scores: options.scores ?? { [slotId]: finalScore },
          reason,
          step_timeouts: {},
          ...(options.failedSlot !== undefined ? { failed_slot: options.failedSlot } : {}),
        }),
      )
    }
  }
  process.finish(options.exit ?? { code: 0, oomKilled: false })
}

/** Emit just the recording header, enough to attribute a watchdog kill to the seat. */
function emitHeader(process: FakeSessionProcess, seed: number): void {
  process.emit(
    JSON.stringify({
      schema_version: 1,
      environment: ENV_ID,
      seed,
      created_at: '2026-06-16T00:00:00.000Z',
    }),
  )
}

/** Subscribe, enqueue, and resolve with the collected events once the run reaches its terminal. */
function runToTerminal(
  handle: RunnerHandle,
  runId: string,
): Promise<{ events: RunEvent[]; status: TerminalRunStatus }> {
  return new Promise((resolve) => {
    const events: RunEvent[] = []
    const unsubscribe = handle.runner.subscribe(runId, (event) => {
      events.push(event)
      if (event.type === 'terminal') {
        unsubscribe()
        resolve({ events, status: event.status })
      }
    })
    handle.runner.enqueue(runId)
  })
}

describe('Docker-backed workflow runner', () => {
  let storage: Storage

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
  })

  it('revokes and drains an exited LLM game before process cleanup', async () => {
    let releaseRevocation = (): void => {}
    const revocationBarrier = new Promise<void>((resolve) => {
      releaseRevocation = resolve
    })
    let revocationStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      revocationStarted = resolve
    })
    const issuer: OfficialGrantIssuer = {
      issue: async () => ({
        keys: { player_0: 'official-key' },
        revoke: () => {
          revocationStarted()
          return revocationBarrier
        },
      }),
    }
    const handle = makeRunner(storage, new FakeDriver(), {
      officialGrantIssuer: issuer,
      llmInternalPort: 9472,
    })
    const run = await makeRun(storage, [naiveGame(0)], { llmPolicy: enabledLlmPolicy() })
    let launched: FakeSessionProcess | undefined
    handle.driver.onLaunch = (launch): void => {
      launched = launch.process
      emitRecording(launch.process, { seed: 1 })
    }

    const terminal = runToTerminal(handle, run.id)
    await started
    expect(launched?.killGraceMs).toEqual([])

    releaseRevocation()
    await expect(terminal).resolves.toMatchObject({ status: 'completed' })
    expect(launched?.killGraceMs).toEqual([5_000])
  })

  it('launches and records an enabled game from only its frozen official policy', async () => {
    let issued: IssueOfficialGrantsInput | undefined
    const issuer: OfficialGrantIssuer = {
      issue: async (input) => {
        issued = input
        return { keys: { player_0: 'official-key' }, revoke: () => Promise.resolve() }
      },
    }
    const handle = makeRunner(storage, new FakeDriver(), {
      officialGrantIssuer: issuer,
      llmInternalPort: 9472,
    })
    const policy = enabledLlmPolicy()
    const run = await makeRun(storage, [naiveGame(0)], { llmPolicy: policy })
    policy.models.small = 'changed-after-snapshot'
    policy.session.token_budget = 999
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config)
    }

    await runToTerminal(handle, run.id)
    const [game] = await storage.listRunGames(run.id)
    expect(issued).toEqual({
      sessionId: game?.id,
      scopeId: run.id,
      agentSlots: ['player_0'],
      models: { small: 'provider-small' },
      limits: { tokenBudget: 100, callBudget: 10, requestsPerMinute: 10 },
    })
    const launch = handle.driver.lastLaunch()
    expect(JSON.parse(launch?.spec.argv[0] ?? '{}').llm).toEqual(llmLaunchConfig.llm)
    expect(launch?.spec.sandbox.network).toBe('llm')
    expect(await storage.getRecording(`${ENV_ID}-${game?.id}`)).toMatchObject({
      llm_scope_id: run.id,
      llm_session_id: game?.id,
    })
  })

  it('runs the persisted schedule in order and writes results, recordings, and completed', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0, 7), naiveGame(1, 9)])
    const seeds: number[] = []
    handle.driver.onLaunch = (launch: FakeLaunch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      seeds.push(config.seed)
      emitRecording(launch.process, config, {
        decisionMs: 10,
        learnMs: 5,
        ticks: 3,
        finalScore: 42,
      })
    }

    const { status } = await runToTerminal(handle, run.id)
    expect(status).toBe('completed')
    expect((await storage.getRun(run.id))?.status).toBe('completed')

    // Games launched in schedule order, each seeded from its persisted row.
    expect(seeds).toEqual([7, 9])

    const games = await storage.listRunGames(run.id)
    expect(games.map((g) => g.status)).toEqual(['completed', 'completed'])
    for (const game of games) {
      expect(game.recording_id).toBe(`${ENV_ID}-${game.id}`)
    }

    const results = await storage.listGameResultsByRun(run.id)
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.episode_score).toBe(42)
      // decision_ms + learn_ms summed over 3 timing-bearing ticks: (10 + 5) * 3.
      expect(result.agent_compute_ms_total).toBe(45)
      expect(result.acted_tick_count).toBe(3)
      expect(result.failed).toBe(0)
      expect(result.agent_kind).toBe('builtin-naive')
    }

    // The recording rows were registered (owner is the operator for a Naive game), each carrying the
    // completed run's termination reason so the replay viewer shows final standings (an automated run
    // has no producing session to supply it).
    const recordings = await storage.listRecordings()
    expect(recordings).toHaveLength(2)
    expect(recordings.every((r) => r.user_id === 'dev-user')).toBe(true)
    expect(recordings.every((r) => r.termination_reason === 'terminated')).toBe(true)

    expect((await storage.getLatestCompletedRun(run.season_id))?.id).toBe(run.id)
  })

  it('starts work enqueued while the previous pump transitions to idle', async () => {
    const handle = makeRunner(storage)
    const first = await makeRun(storage, [naiveGame(0, 7)])
    const second = await makeRun(storage, [naiveGame(0, 9)])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config)
    }

    const originalGetRun = storage.getRun.bind(storage)
    let secondRunRead = false
    storage.getRun = (runId) => {
      if (runId === second.id) secondRunRead = true
      return originalGetRun(runId)
    }

    await runToTerminal(handle, first.id)
    // Let the pump observe its empty queue while its outer `.finally` callback is still pending.
    // Enqueuing in this microtask window used to see a non-null pump and strand the new run.
    await Promise.resolve()
    await Promise.resolve()

    const secondTerminal = runToTerminal(handle, second.id)
    expect(secondRunRead).toBe(true)
    await expect(secondTerminal).resolves.toMatchObject({ status: 'completed' })
  })

  it('records the envelope score, not a stale recording score, for a non-terminal-acting seat', async () => {
    // A turn-based env pays its seats only at the terminal tick, and the recording writes only the
    // acting seat per tick, so a seat that did not act last reads back a stale 0 in the recording. The
    // result envelope carries every seat's true final score, so the runner must trust it over the
    // recording-derived value. Here the recording reports 0 each tick but the envelope reports 42.
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0, 7)])
    handle.driver.onLaunch = (launch: FakeLaunch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config, {
        ticks: 3,
        finalScore: 0, // the recording's per-tick score for this seat stays 0 (it never acted last)
        scores: { player_0: 42 }, // the envelope's authoritative final score
      })
    }

    const { status } = await runToTerminal(handle, run.id)
    expect(status).toBe('completed')
    const results = await storage.listGameResultsByRun(run.id)
    expect(results).toHaveLength(1)
    expect(results[0]?.episode_score).toBe(42)
  })

  it('treats an absent learn_ms as zero in the compute total', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0)])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config, { decisionMs: 8, ticks: 2 }) // no learn_ms
    }
    await runToTerminal(handle, run.id)
    const [result] = await storage.listGameResultsByRun(run.id)
    expect(result?.agent_compute_ms_total).toBe(16)
    expect(result?.acted_tick_count).toBe(2)
  })

  it('folds chat_ms into the compute total alongside decision_ms and learn_ms', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0)])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      // (decision 8 + learn 3 + chat 4) over 2 ticks = 30.
      emitRecording(launch.process, config, { decisionMs: 8, learnMs: 3, chatMs: 4, ticks: 2 })
    }
    await runToTerminal(handle, run.id)
    const [result] = await storage.listGameResultsByRun(run.id)
    expect(result?.agent_compute_ms_total).toBe(30)
    expect(result?.acted_tick_count).toBe(2)
  })

  it('launches workflow containers headless and passes timeout overrides', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0, 13)], {
      overrides: { step_timeout_ms: 250, episode_timeout_ms: 5_000 },
    })
    let config: Record<string, unknown> | null = null
    handle.driver.onLaunch = (launch): void => {
      config = JSON.parse(launch.spec.argv[0] ?? '{}') as Record<string, unknown>
      emitRecording(launch.process, { seed: config.seed as number })
    }
    await runToTerminal(handle, run.id)
    expect(config).toMatchObject({
      seed: 13,
      human_timeout_ms: null,
      headless: true,
      step_timeout_ms: 250,
      episode_timeout_ms: 5_000,
    })
    expect(handle.driver.lastLaunch()?.spec.sandbox).toEqual({
      cpus: 1,
      memoryMb: 512,
      readOnlyRoot: true,
      scratch: { containerPath: '/tmp', sizeMb: 256 },
      network: 'none',
      mounts: [{ hostPath: './data/recordings', containerPath: '/recordings', readOnly: false }],
    })
  })

  it('spreads the messaging override into the workflow session config', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0, 13)], {
      overrides: { messaging: { enabled: false, message_cap: 80 } },
    })
    let config: Record<string, unknown> | null = null
    handle.driver.onLaunch = (launch): void => {
      config = JSON.parse(launch.spec.argv[0] ?? '{}') as Record<string, unknown>
      emitRecording(launch.process, { seed: config.seed as number })
    }
    await runToTerminal(handle, run.id)
    expect(config).toMatchObject({ messaging_enabled: false, message_cap: 80 })
  })

  it('omits the messaging keys when the season sets no messaging override', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0, 13)])
    let config: Record<string, unknown> | null = null
    handle.driver.onLaunch = (launch): void => {
      config = JSON.parse(launch.spec.argv[0] ?? '{}') as Record<string, unknown>
      emitRecording(launch.process, { seed: config.seed as number })
    }
    await runToTerminal(handle, run.id)
    expect(config).not.toHaveProperty('messaging_enabled')
    expect(config).not.toHaveProperty('message_cap')
  })

  it('kills a hung game at the wall-clock watchdog and continues the schedule', async () => {
    const handle = makeRunner(storage, new FakeDriver(), {
      killGraceMs: 2,
      gameWatchdogGraceMs: 1,
    })
    const run = await makeRun(storage, [naiveGame(0, 1), naiveGame(1, 2)], {
      overrides: { episode_timeout_ms: 10 },
    })
    let launchCount = 0
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      if (launchCount++ === 0) {
        emitHeader(launch.process, config.seed)
        return
      }
      emitRecording(launch.process, config, { finalScore: 7 })
    }

    const { events, status } = await runToTerminal(handle, run.id)
    expect(status).toBe('completed')
    expect(handle.driver.launches[0]?.process.killGraceMs).toEqual([2])
    expect(handle.driver.launches).toHaveLength(2)

    const games = await storage.listRunGames(run.id)
    expect(games.map((g) => g.status)).toEqual(['timed_out', 'completed'])
    const results = await storage.listGameResultsByRun(run.id)
    const timedOut = results.find((result) => result.game_id === games[0]?.id)
    expect(timedOut?.failed).toBe(1)
    expect(timedOut?.episode_score).toBe(0)
    expect(timedOut?.failure_reason).toMatch(/watchdog/)
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as { line: string }).line)
    expect(logs.some((line) => line.includes('wall-clock watchdog'))).toBe(true)
  })

  it('scores an attributable crash at the forfeit floor without aborting later games', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0), naiveGame(1)])
    let launchCount = 0
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      if (launchCount++ === 0) {
        // A partial recording then a non-zero exit: an attributable agent crash. The partial score
        // (17) is high, but a forfeit must not bank it — the seat takes the environment floor instead.
        emitRecording(launch.process, config, {
          ticks: 2,
          finalScore: 17,
          exit: { code: 1, oomKilled: false },
        })
      } else {
        emitRecording(launch.process, config, { finalScore: 5 })
      }
    }

    const { status } = await runToTerminal(handle, run.id)
    // A single crash never fails the whole run.
    expect(status).toBe('completed')

    const games = await storage.listRunGames(run.id)
    expect(games[0]?.status).toBe('failed')
    expect(games[1]?.status).toBe('completed')

    const results = await storage.listGameResultsByRun(run.id)
    expect(results).toHaveLength(2)
    const crashed = results.find((r) => r.failed === 1)
    // The forfeited seat takes Flappy Bird's floor (0), discarding its 17-point partial.
    expect(crashed?.episode_score).toBe(forfeitScore(ENV_ID))
    expect(crashed?.episode_score).toBe(0)
    expect(crashed?.failure_reason).toMatch(/exited with code 1/)
    // The clean later game keeps its honestly-earned recorded score.
    const clean = results.find((r) => r.failed === 0)
    expect(clean?.episode_score).toBe(5)

    // The crashed game's recording carries no termination reason — its replay shows no final standings
    // even though the partial envelope still reported 'terminated' — while the clean game's does.
    expect((await storage.getRecording(`${ENV_ID}-${games[0]?.id}`))?.termination_reason).toBe(null)
    expect((await storage.getRecording(`${ENV_ID}-${games[1]?.id}`))?.termination_reason).toBe(
      'terminated',
    )
  })

  it('charges a multi-seat crash to the offending seat alone, not its co-seats', async () => {
    const handle = makeRunner(storage)
    // A two-seat game, the shape the composed multi-submission path now schedules. The harness names
    // the seat whose agent raised (player_1); the co-seat (player_0) must not inherit a false failure,
    // which would pollute an innocent competitor's public failure count.
    const run = await makeRun(storage, [
      {
        match_index: 0,
        game_index: 0,
        seed: 1,
        slots: [{ kind: 'builtin-naive' }, { kind: 'builtin-naive' }],
      },
    ])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config, {
        ticks: 2,
        scores: { player_0: 9, player_1: 4 },
        failedSlot: 'player_1',
        exit: { code: 1, oomKilled: false },
      })
    }

    const { status } = await runToTerminal(handle, run.id)
    expect(status).toBe('completed') // one crashed game never fails the whole run
    const games = await storage.listRunGames(run.id)
    expect(games[0]?.status).toBe('failed')

    const results = await storage.listGameResultsByRun(run.id)
    const bySlot = new Map(results.map((r) => [r.slot_index, r]))
    // The named seat carries the failure and its reason; its co-seat stays clean.
    expect(bySlot.get(1)?.failed).toBe(1)
    expect(bySlot.get(1)?.failure_reason).toMatch(/exited with code 1/)
    expect(bySlot.get(0)?.failed).toBe(0)
    expect(bySlot.get(0)?.failure_reason).toBeNull()
  })

  it('marks a timed-out agent timed_out with a failed result row', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0)])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config, { finalScore: 3, reason: 'episode_limit' })
    }
    await runToTerminal(handle, run.id)
    const games = await storage.listRunGames(run.id)
    expect(games[0]?.status).toBe('timed_out')
    const [result] = await storage.listGameResultsByRun(run.id)
    expect(result?.failed).toBe(1)
    // A budget overrun is a forfeit: the seat takes the floor (0), not its 3-point partial.
    expect(result?.episode_score).toBe(forfeitScore(ENV_ID))
    expect(result?.failure_reason).toMatch(/episode/)
  })

  it('marks an infrastructure fault failed and writes no result row', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0)])
    handle.driver.onLaunch = (launch): void => {
      // No readable recording header at all (an unreadable / never-written recording).
      emitRecording(
        launch.process,
        { seed: 1 },
        { omitHeader: true, exit: { code: 0, oomKilled: false } },
      )
    }
    const { status } = await runToTerminal(handle, run.id)
    expect(status).toBe('completed')
    const games = await storage.listRunGames(run.id)
    expect(games[0]?.status).toBe('failed')
    expect(games[0]?.error).toMatch(/no readable recording/)
    expect(await storage.listGameResultsByRun(run.id)).toHaveLength(0)
    // No recording row is invented for an infrastructure fault.
    expect(await storage.listRecordings()).toHaveLength(0)
  })

  it('faults a clean exit that produced a recording but no result envelope', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0)])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      // A readable recording, then a clean exit (code 0) with no `result` envelope: the container did
      // not fulfil its output contract. The runner must not invent a `terminated` standings card from
      // the (stale-prone) recording scores; it faults the game like a missing-recording infra fault.
      emitRecording(launch.process, config, { finalScore: 3, omitResult: true })
    }
    const { status } = await runToTerminal(handle, run.id)
    expect(status).toBe('completed') // one faulted game never fails the whole run
    const games = await storage.listRunGames(run.id)
    expect(games[0]?.status).toBe('failed')
    expect(games[0]?.error).toMatch(/without a valid result envelope/)
    // No invented result row and no recording row, exactly like a missing-recording infrastructure fault.
    expect(await storage.listGameResultsByRun(run.id)).toHaveLength(0)
    expect(await storage.listRecordings()).toHaveLength(0)
  })

  it('relays container diagnostics and game-status transitions as live events', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0)])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config, { diagnostics: ['container booting'] })
    }
    const { events } = await runToTerminal(handle, run.id)
    const logs = events.filter((e) => e.type === 'log').map((e) => (e as { line: string }).line)
    expect(logs.some((line) => line.includes('container booting'))).toBe(true)
    expect(logs.some((line) => line.includes('started'))).toBe(true)
    const statuses = events
      .filter((e) => e.type === 'game_status')
      .map((e) => (e as { status: string }).status)
    expect(statuses).toEqual(['running', 'completed'])
  })

  it('cancels mid-schedule: stops further games and settles the run cancelled', async () => {
    const handle = makeRunner(storage)
    const run = await makeRun(storage, [naiveGame(0), naiveGame(1), naiveGame(2)])
    let launchCount = 0
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      if (launchCount++ === 0) {
        // Cancel while the first game is in flight, then let it finish (its kill resolves the exit).
        handle.runner.cancel(run.id)
      }
      emitRecording(launch.process, config)
    }
    const { status } = await runToTerminal(handle, run.id)
    expect(status).toBe('cancelled')
    expect((await storage.getRun(run.id))?.status).toBe('cancelled')
    // The later games never ran; only the first container launched.
    expect(handle.driver.launches.length).toBe(1)
    const games = await storage.listRunGames(run.id)
    expect(games[1]?.status).toBe('cancelled')
    expect(games[2]?.status).toBe('cancelled')
    // A cancelled run is not the latest completed run.
    expect(await storage.getLatestCompletedRun(run.season_id)).toBeUndefined()
  })

  it('shutdown rejects new work, revokes before kill, and drains the active pump', async () => {
    let releaseRevocation = (): void => {}
    const revocationBarrier = new Promise<void>((resolve) => {
      releaseRevocation = resolve
    })
    let markRevocationStarted = (): void => {}
    const revocationStarted = new Promise<void>((resolve) => {
      markRevocationStarted = resolve
    })
    const issuer: OfficialGrantIssuer = {
      issue: async () => ({
        keys: { player_0: 'official-key' },
        revoke: () => {
          markRevocationStarted()
          return revocationBarrier
        },
      }),
    }
    const handle = makeRunner(storage, new FakeDriver(), {
      officialGrantIssuer: issuer,
      llmInternalPort: 9472,
    })
    const run = await makeRun(storage, [naiveGame(0)], { llmPolicy: enabledLlmPolicy() })
    let markLaunched = (): void => {}
    const launched = new Promise<void>((resolve) => {
      markLaunched = resolve
    })
    handle.driver.onLaunch = () => markLaunched()

    const terminal = runToTerminal(handle, run.id)
    await launched
    const shutdown = handle.runner.shutdown()
    await revocationStarted
    let shutdownSettled = false
    void shutdown.then(() => {
      shutdownSettled = true
    })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    expect(() => handle.runner.enqueue('late-run')).toThrow(/shutting down/)

    releaseRevocation()
    await shutdown
    expect(handle.driver.lastLaunch()?.process.killGraceMs).toEqual([5_000])
    await expect(terminal).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('re-runs into a fresh run that becomes the latest completed', async () => {
    const handle = makeRunner(storage)
    const first = await makeRun(storage, [naiveGame(0)])
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config, { finalScore: 3 })
    }
    await runToTerminal(handle, first.id)

    // A second run for the same season (the re-run).
    const second = await storage.createRunWithSchedule(
      first.season_id,
      'dev-user',
      [],
      [naiveGame(0)],
      disabledLlmPolicy,
    )
    await runToTerminal(handle, second.id)

    expect(second.id).not.toBe(first.id)
    expect((await storage.getLatestCompletedRun(first.season_id))?.id).toBe(second.id)
  })

  it('resolves the submission overlay image and attributes its recording to the owner', async () => {
    const driver = new FakeDriver()
    // Seed a cached overlay for the submission so the reuse path returns it without the source seam.
    const submission = await storage.createSubmission({
      season_id: 'placeholder',
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'git',
      repo_url: 'https://example.com/a.git',
      commit_sha: 'abc123',
      local_path: null,
      ref: null,
      created_at: '2026-06-16T00:00:00.000Z',
    })
    driver.overlayImages.set('overlay-ref', {
      ref: 'overlay-ref',
      submissionId: submission.id,
      createdAtMs: 1,
    })
    const handle = makeRunner(storage, driver)
    const submissionRef: AgentRef = {
      kind: 'submission',
      submission_id: submission.id,
      user_id: 'alice',
    }
    const run = await makeRun(
      storage,
      [{ match_index: 0, game_index: 0, seed: 1, slots: [submissionRef] }],
      { submissions: [submissionRef] },
    )
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as { seed: number }
      emitRecording(launch.process, config, { finalScore: 99 })
    }

    await runToTerminal(handle, run.id)
    // The launch used the cached overlay ref, not the base image.
    expect(handle.driver.lastLaunch()?.spec.image.ref).toBe('overlay-ref')

    const [result] = await storage.listGameResultsByRun(run.id)
    expect(result?.agent_kind).toBe('submission')
    expect(result?.agent_submission_id).toBe(submission.id)
    expect(result?.episode_score).toBe(99)

    // The recording is owned by the submission's owner, not the operator.
    const recordings = await storage.listRecordings()
    expect(recordings[0]?.user_id).toBe('alice')
  })

  it('snapshots owner display names into headless header labels while keeping stable ids', async () => {
    const driver = new FakeDriver()
    // Two single-seat games: one owner the directory knows, one with no row (the fallback).
    const submissions: Submission[] = []
    for (const owner of ['alice', 'ghost-user']) {
      const submission = await storage.createSubmission({
        season_id: 'placeholder',
        env_id: ENV_ID,
        user_id: owner,
        source_kind: 'git',
        repo_url: 'https://example.com/a.git',
        commit_sha: 'abc123',
        local_path: null,
        ref: null,
        created_at: '2026-06-16T00:00:00.000Z',
      })
      driver.overlayImages.set(`overlay-${owner}`, {
        ref: `overlay-${owner}`,
        submissionId: submission.id,
        createdAtMs: 1,
      })
      submissions.push(submission)
    }
    const refs: AgentRef[] = submissions.map((submission) => ({
      kind: 'submission',
      submission_id: submission.id,
      user_id: submission.user_id,
    }))
    const handle = makeRunner(storage, driver, {
      userDirectory: {
        namesFor: (ids) =>
          Promise.resolve(
            new Map<string, string>(ids.includes('alice') ? [['alice', 'Alice Chen']] : []),
          ),
      },
    })
    const run = await makeRun(
      storage,
      refs.map((ref, index) => ({
        match_index: 0,
        game_index: index,
        seed: index + 1,
        slots: [ref],
      })),
      { submissions: refs },
    )
    const players: Array<Record<string, unknown>> = []
    handle.driver.onLaunch = (launch): void => {
      const config = JSON.parse(launch.spec.argv[0] ?? '{}') as {
        seed: number
        players: Record<string, unknown>
      }
      players.push(config.players)
      emitRecording(launch.process, config)
    }

    const { status } = await runToTerminal(handle, run.id)
    expect(status).toBe('completed')
    // `user` keeps the stable id in both headers; the label carries the resolved display name and
    // falls back to the id where the directory has no row.
    expect(players).toEqual([
      {
        player_0: {
          kind: 'agent',
          label: "Alice Chen's agent",
          user: 'alice',
          submission_id: submissions[0]?.id,
        },
      },
      {
        player_0: {
          kind: 'agent',
          label: "ghost-user's agent",
          user: 'ghost-user',
          submission_id: submissions[1]?.id,
        },
      },
    ])
  })
})
