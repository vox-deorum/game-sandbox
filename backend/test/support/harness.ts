/**
 * Shared scaffolding for the orchestrator, relay, and HTTP suites: a config builder, a controlled
 * environment registry, a fake browser socket, and microtask/timer helpers. No Docker, no Python —
 * everything runs against the {@link FakeDriver} and in-memory SQLite.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'

import { type AppDeps, buildApp } from '../../src/app.js'
import type { Auth } from '../../src/auth/auth.js'
import { createUserDirectory, type UserDirectory } from '../../src/auth/users.js'
import type { Config } from '../../src/config/config.js'
import type { ExecutionDriver } from '../../src/driver/index.js'
import { EnvironmentRegistry } from '../../src/environments/registry.js'
import { Retention } from '../../src/recordings/retention.js'
import { RecordingsStore } from '../../src/recordings/store.js'
import type { ClientSocket } from '../../src/session/live-session.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import type { FrozenRunInput, FrozenRunPlan, Storage } from '../../src/storage/index.js'
import type { SeasonRun } from '../../src/storage/schema.js'
import { openSqlite } from '../../src/storage/sqlite.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import {
  createSubmissionSource,
  type SubmissionSource,
  type SubmissionSourceDeps,
} from '../../src/submission/source/index.js'
import { type SubmissionEnqueuer, ValidationWorker } from '../../src/submission/worker.js'
import type { WorkflowRunner } from '../../src/workflow/runner.js'
import { makeTestAuth, type TestUsers } from './auth.js'
import { TEST_AUTH_OPTIONS } from './auth-options.js'
import { FakeDriver } from './fake-driver.js'
import { makeTestLlmOptions } from './llm-options.js'
import { StubWorkflowRunner } from './stub-runner.js'

/** An in-memory storage plus the real Better Auth instance and user-minting harness on one handle. */
export interface TestStack {
  storage: Storage
  /** The raw shared connection, for suites that read the auth tables directly. */
  sqlite: BetterSqlite3.Database
  auth: Auth
  users: TestUsers
  /** The display-name directory over the same connection, for the `userDirectory` every `buildApp` needs. */
  userDirectory: UserDirectory
}

/**
 * Open a fresh `:memory:` database and build a Better Auth instance and {@link TestUsers} harness on
 * its raw connection, so a suite can mint real signed-in users and pass the `auth` every `buildApp`
 * now requires. Close the returned `storage` last in teardown (it owns the shared connection).
 */
export async function openTestStack(): Promise<TestStack> {
  const { storage, sqlite } = await openSqlite(':memory:')
  const { auth, users } = await makeTestAuth(sqlite)
  return { storage, sqlite, auth, users, userDirectory: createUserDirectory(sqlite) }
}

/** Explicit dependency overrides for {@link openTestApp}; omitted seams use Docker-free defaults. */
export interface OpenTestAppOptions {
  config?: Config
  driver?: ExecutionDriver
  environments?: EnvironmentRegistry
  orchestrator?: Orchestrator
  recordings?: RecordingsStore
  retention?: Retention
  userDirectory?: UserDirectory
  knownDepsVersions?: ReadonlySet<number>
  workflowRunner?: WorkflowRunner
  submissionSource?: SubmissionSource
  submissionSnapshots?: SubmissionSnapshotStore
  validationWorker?: SubmissionEnqueuer
  allowLocalSubmissions?: boolean
  siteName?: string
  siteIconUrl?: string
  siteShortName?: string
  templateRepoUrl?: string
  githubAuth?: boolean
  frontendDir?: string
  googleAnalyticsId?: string
  docsDir?: string
  docsIndexFile?: string
  llmDevelopment?: AppDeps['llmDevelopment']
  officialTelemetry?: AppDeps['officialTelemetry']
}

/** A complete Docker-free app fixture and the handles API tests commonly need. */
export interface TestApp {
  app: FastifyInstance
  storage: Storage
  users: TestUsers
  config: Config
  driver: ExecutionDriver
  environments: EnvironmentRegistry
  orchestrator: Orchestrator
  recordings: RecordingsStore
  rootDir: string
  /** Idempotently stop sessions, close Fastify/storage, and remove the fixture's temporary root. */
  close(): Promise<void>
}

/**
 * Open the standard Fastify test stack with real in-memory storage/auth and Docker-free execution.
 * Every non-core app dependency is a named override, so a suite keeps its special seams visible.
 */
export async function openTestApp(options: OpenTestAppOptions = {}): Promise<TestApp> {
  const rootDir = mkdtempSync(join(tmpdir(), 'gs-app-test-'))
  const stack = await openTestStack()
  const config =
    options.config ??
    makeConfig({
      dataDir: rootDir,
      recordingsDir: join(rootDir, 'recordings'),
      submissionsDir: join(rootDir, 'submissions'),
    })
  const driver = options.driver ?? new FakeDriver()
  const environments = options.environments ?? makeEnvironments()
  const orchestrator =
    options.orchestrator ??
    new Orchestrator({ driver, storage: stack.storage, environments, config })
  const recordings = options.recordings ?? new RecordingsStore(config.recordingsDir)
  const retention = options.retention ?? new Retention(stack.storage, recordings, config)
  const snapshots =
    options.submissionSnapshots ?? new SubmissionSnapshotStore(config.submissionsDir)
  const submissionDeps = makeSubmissionDeps(stack.storage, config, {
    driver,
    snapshots,
    knownTemplateVersions: options.knownDepsVersions,
  })
  const app = await buildApp({
    orchestrator,
    environments,
    recordings,
    retention,
    auth: stack.auth,
    userDirectory: options.userDirectory ?? stack.userDirectory,
    llm: config.llm,
    ...(options.officialTelemetry === undefined
      ? {}
      : { officialTelemetry: options.officialTelemetry }),
    ...(options.llmDevelopment === undefined ? {} : { llmDevelopment: options.llmDevelopment }),
    ...submissionDeps,
    ...(options.siteName === undefined ? {} : { siteName: options.siteName }),
    ...(options.siteIconUrl === undefined ? {} : { siteIconUrl: options.siteIconUrl }),
    ...(options.siteShortName === undefined ? {} : { siteShortName: options.siteShortName }),
    templateRepoUrl: options.templateRepoUrl ?? config.templateRepoUrl,
    ...(options.githubAuth === undefined ? {} : { githubAuth: options.githubAuth }),
    ...(options.frontendDir === undefined ? {} : { frontendDir: options.frontendDir }),
    ...(options.googleAnalyticsId === undefined
      ? {}
      : { googleAnalyticsId: options.googleAnalyticsId }),
    ...(options.docsDir === undefined ? {} : { docsDir: options.docsDir }),
    ...(options.docsIndexFile === undefined ? {} : { docsIndexFile: options.docsIndexFile }),
    knownDepsVersions: options.knownDepsVersions ?? submissionDeps.knownDepsVersions,
    workflowRunner: options.workflowRunner ?? submissionDeps.workflowRunner,
    submissionSource: options.submissionSource ?? submissionDeps.submissionSource,
    submissionSnapshots: snapshots,
    validationWorker: options.validationWorker ?? submissionDeps.validationWorker,
    allowLocalSubmissions: options.allowLocalSubmissions ?? submissionDeps.allowLocalSubmissions,
  })
  await app.ready()

  let closePromise: Promise<void> | undefined
  return {
    app,
    storage: stack.storage,
    users: stack.users,
    config,
    driver,
    environments,
    orchestrator,
    recordings,
    rootDir,
    close: () => {
      closePromise ??= (async () => {
        try {
          await orchestrator.shutdown()
        } finally {
          try {
            await app.close()
          } finally {
            await stack.storage.close()
            rmSync(rootDir, { recursive: true, force: true })
          }
        }
      })()
      return closePromise
    },
  }
}

/** A config with class-scale defaults overridable per test (e.g. a tiny idle window). */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    listenHost: '127.0.0.1',
    siteName: 'Game Sandbox',
    siteIconUrl: '/game-sandbox-icon.png',
    siteShortName: 'Game Sandbox',
    templateRepoUrl: 'https://github.com/vox-deorum/game-agent-template',
    dataDir: './data',
    dbPath: ':memory:',
    recordingsDir: './data/recordings',
    submissionsDir: './data/submissions',
    docsDir: './docs',
    sessionIdleTimeoutMs: 60_000,
    sessionMaxDurationMs: null,
    recordingRetentionDays: 30,
    recordingUserQuota: 100,
    recordingSweepIntervalMs: 3_600_000,
    overlayImageBudget: 50,
    overlayImageSweepIntervalMs: 3_600_000,
    sessionOverlayReclaimAgeMs: 3_600_000,
    sandbox: { cpus: 1, memoryMb: 512, memoryPerPlayerMb: 32, scratchMb: 256, pids: 512 },
    executionDriver: 'docker',
    docker: {
      imageTagPrefix: 'game-sandbox',
      imagePolicy: 'reuse',
      overlayBuildTimeoutMs: 120_000,
      llmRelay: { mode: 'host-gateway' },
    },
    submission: {
      allowLocalSubmissions: false,
      gitTimeoutMs: 15_000,
      loadCheckTimeoutMs: 30_000,
      submissionMaxSizeBytes: 25 * 1024 * 1024,
    },
    auth: { ...TEST_AUTH_OPTIONS },
    llm: makeTestLlmOptions(),
    ...overrides,
  }
}

/**
 * The submission-specific {@link import('../../src/app.js').AppDeps} slice every `buildApp` caller now
 * needs: the storage seam, the source seam (tests may inject fake git/GitHub clients), the bounded
 * validation worker, and the local-source gate. The worker defaults to a {@link FakeDriver} since the
 * non-submission suites never enqueue; submission suites pass their own driver and source fakes.
 */
export function makeSubmissionDeps(
  storage: Storage,
  config: Config,
  options: {
    driver?: ExecutionDriver
    source?: SubmissionSourceDeps
    knownTemplateVersions?: ReadonlySet<number>
    snapshots?: SubmissionSnapshotStore
  } = {},
): {
  storage: Storage
  submissionSource: ReturnType<typeof createSubmissionSource>
  submissionSnapshots: SubmissionSnapshotStore
  validationWorker: ValidationWorker
  allowLocalSubmissions: boolean
  knownDepsVersions: ReadonlySet<number>
  workflowRunner: WorkflowRunner
  docsDir: string
} {
  const driver = options.driver ?? new FakeDriver()
  const submissionSource = createSubmissionSource(config.submission, options.source)
  // A throwaway temp root per call so a suite that does drive the pipeline writes real snapshots
  // without colliding with another suite; suites that never enqueue simply leave it empty.
  const submissionSnapshots =
    options.snapshots ?? new SubmissionSnapshotStore(mkdtempSync(join(tmpdir(), 'gs-snap-test-')))
  const validationWorker = new ValidationWorker({
    driver,
    storage,
    source: submissionSource,
    snapshots: submissionSnapshots,
    submissionMaxSizeBytes: config.submission.submissionMaxSizeBytes,
    sandbox: config.sandbox,
    loadCheckTimeoutMs: config.submission.loadCheckTimeoutMs,
    knownTemplateVersions: options.knownTemplateVersions ?? new Set([1]),
  })
  return {
    storage,
    submissionSource,
    submissionSnapshots,
    validationWorker,
    allowLocalSubmissions: config.submission.allowLocalSubmissions,
    // The non-leaderboard suites don't exercise the admin API, but buildApp still requires a runner;
    // a stub runner completes the deps without Docker.
    knownDepsVersions: options.knownTemplateVersions ?? new Set([1]),
    workflowRunner: new StubWorkflowRunner(storage),
    // The docs routes require a root; suites that don't exercise them get the placeholder from
    // makeConfig, and the docs suite builds its own fixture and passes an explicit docsDir override.
    docsDir: config.docsDir,
  }
}

/** A field-complete environment metadata entry, overridable. */
export function meta(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    env_id: 'flappy_bird',
    display_name: 'Flappy Bird',
    description: 'test env',
    builtin_agents: [{ name: 'naive', label: 'Naive agent' }],
    layout: { kind: 'player_bounds', min: 1, max: 1 },
    human_players: ['player_0'],
    human_timeout_ms: null,
    recommended_episode_ticks: 1000,
    pace_interval_ms: 50,
    stepping: 'sequential',
    step_limit_ms: 1000,
    episode_limit_ms: 120_000,
    messaging: false,
    message_cap: null,
    llm: false,
    renderer: 'flappy-bird',
    seat_order_matters: false,
    view_interval_ms: null,
    live_interval_ms: null,
    human_pause: 'session',
    parameters: [
      {
        name: 'players',
        title: 'Players',
        description: 'Number of players.',
        type: 'int',
        default: 1,
        min: 1,
        max: 1,
      },
      {
        name: 'pipe_gap',
        title: 'Pipe gap',
        description: 'Vertical gap between pipes.',
        type: 'int',
        default: 100,
        min: 50,
        max: 200,
      },
    ],
    ...overrides,
  }
}

/**
 * A controlled registry with the shapes the tests need: the paced single-human Flappy env, a
 * turn-based env with a metadata human timeout (to prove the override flows into the config), a
 * watch-only env with no human-capable player (to prove a human assignment is rejected), and a
 * four-player, all-human-capable, turn-based Hearts env (the multiplayer validation and attribution
 * tests).
 */
export function makeEnvironments(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      meta({}),
      meta({ env_id: 'simultaneous', stepping: 'simultaneous' }),
      meta({ env_id: 'turn_based', pace_interval_ms: null, human_timeout_ms: 5000 }),
      meta({ env_id: 'watch_only', human_players: [] }),
      meta({
        env_id: 'hearts',
        layout: { kind: 'player_bounds', min: 4, max: 4 },
        human_players: ['player_0', 'player_1', 'player_2', 'player_3'],
        human_timeout_ms: 60000,
        pace_interval_ms: null,
        renderer: 'hearts',
        seat_order_matters: true,
        parameters: [
          {
            name: 'players',
            title: 'Players',
            description: 'Number of players.',
            type: 'int',
            default: 4,
            min: 4,
            max: 4,
          },
        ],
      }),
      // A messaging-enabled partnership env (Spades-shaped) so the messaging-resolution tests have an
      // environment that opts in, with a metadata cap to combine against a season override.
      meta({
        env_id: 'chatty',
        layout: { kind: 'player_bounds', min: 4, max: 4 },
        human_players: ['player_0', 'player_1', 'player_2', 'player_3'],
        human_timeout_ms: 60000,
        pace_interval_ms: null,
        messaging: true,
        message_cap: 120,
        renderer: 'spades',
        seat_order_matters: true,
        parameters: [
          {
            name: 'players',
            title: 'Players',
            description: 'Number of players.',
            type: 'int',
            default: 4,
            min: 4,
            max: 4,
          },
        ],
      }),
      meta({
        env_id: 'restricted',
        builtin_agents: [
          { name: 'naive', label: 'Naive agent' },
          { name: 'scripted_hero', label: 'Scripted hero' },
        ],
        layout: {
          kind: 'seat_plans',
          plans: [
            {
              key: 'adventure',
              title: 'Adventure',
              seats: [{ players: [0], restricted_builtin: 'scripted_hero' }, { players: [1] }],
            },
          ],
        },
        human_players: ['player_0', 'player_1'],
        pace_interval_ms: null,
        renderer: 'fake',
        seat_order_matters: true,
        parameters: [
          {
            name: 'seat_plan',
            title: 'Seat plan',
            description: 'Seat-to-player layout for each game.',
            type: 'choice',
            default: 'adventure',
            choices: [{ value: 'adventure', label: 'Adventure' }],
          },
        ],
      }),
    ]),
  )
}

/** A browser socket double: records frames, reports a settable backlog, tracks close. */
export class FakeSocket implements ClientSocket {
  readonly received: string[] = []
  closed = false
  bufferedAmount = 0
  private throwOnSend = false

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error('socket send failed')
    }
    this.received.push(data)
  }

  close(): void {
    this.closed = true
  }

  /** Make the next and subsequent sends throw, simulating a dead socket. */
  breakSends(): void {
    this.throwOnSend = true
  }
}

/**
 * Create a season run and unwrap the outcome for the many suites that just need a run to exist.
 * A rejection fails here with its typed code and reason, rather than surfacing later as a confusing
 * property access. Suites that assert on the rejection itself call `createRunWithSchedule` directly.
 */
export async function createRunOrFail(
  storage: Storage,
  seasonId: string,
  requestedBy: string,
  build: (input: FrozenRunInput) => Omit<Extract<FrozenRunPlan, { ok: true }>, 'ok'>,
): Promise<SeasonRun> {
  const outcome = await storage.createRunWithSchedule(seasonId, requestedBy, (input) => ({
    ok: true,
    ...build(input),
  }))
  if (!outcome.ok) {
    throw new Error(`expected a scheduled run, got ${outcome.code}: ${outcome.reason}`)
  }
  return outcome.run
}

/** Yield to the event loop so the relay's `for await` loop drains pushed lines. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A real-timer delay for the short idle/max-window tests. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
