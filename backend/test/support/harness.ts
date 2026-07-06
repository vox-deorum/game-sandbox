/**
 * Shared scaffolding for the orchestrator, relay, and HTTP suites: a config builder, a controlled
 * environment registry, a fake browser socket, and microtask/timer helpers. No Docker, no Python —
 * everything runs against the {@link FakeDriver} and in-memory SQLite.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Config } from '../../src/config.js'
import type { ExecutionDriver } from '../../src/driver/index.js'
import { EnvironmentRegistry } from '../../src/environments.js'
import type { ClientSocket } from '../../src/session/live-session.js'
import type { Storage } from '../../src/storage/index.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import {
  createSubmissionSource,
  type SubmissionSourceDeps,
} from '../../src/submission/source/index.js'
import { ValidationWorker } from '../../src/submission/worker.js'
import type { WorkflowRunner } from '../../src/workflow/runner.js'
import { FakeDriver } from './fake-driver.js'
import { StubWorkflowRunner } from './stub-runner.js'

/** A config with class-scale defaults overridable per test (e.g. a tiny idle window). */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    siteName: 'Game Sandbox',
    siteShortName: 'Game Sandbox',
    dataDir: './data',
    dbPath: ':memory:',
    recordingsDir: './data/recordings',
    submissionsDir: './data/submissions',
    sessionIdleTimeoutMs: 60_000,
    sessionMaxDurationMs: 600_000,
    // The identities the start-succeeding suites use; allowlist tests override this explicitly.
    sessionAllowlist: ['dev-user', 'alice', 'bob'],
    operatorAllowlist: ['dev-user'],
    recordingRetentionDays: 30,
    recordingUserQuota: 100,
    recordingSweepIntervalMs: 3_600_000,
    overlayImageBudget: 50,
    overlayImageSweepIntervalMs: 3_600_000,
    sandbox: { cpus: 1, memoryMb: 512, scratchMb: 256 },
    executionDriver: 'docker',
    docker: {
      imageTagPrefix: 'game-sandbox',
      imagePolicy: 'reuse',
      overlayBuildTimeoutMs: 120_000,
    },
    submission: {
      allowLocalSubmissions: false,
      gitTimeoutMs: 15_000,
      loadCheckTimeoutMs: 30_000,
      submissionMaxSizeBytes: 25 * 1024 * 1024,
    },
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
  operatorAllowlist: readonly string[]
  knownDepsVersions: ReadonlySet<number>
  workflowRunner: WorkflowRunner
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
    // The non-leaderboard suites don't exercise the admin API, but buildApp now requires these; a
    // stub runner and the config's operator allowlist complete the deps without Docker.
    operatorAllowlist: config.operatorAllowlist,
    knownDepsVersions: options.knownTemplateVersions ?? new Set([1]),
    workflowRunner: new StubWorkflowRunner(storage),
  }
}

/** A field-complete environment metadata entry, overridable. */
function meta(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    env_id: 'flappy_bird',
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
    ...overrides,
  }
}

/**
 * A controlled registry with the shapes the tests need: the paced single-human Flappy env, a
 * turn-based env with a metadata human timeout (to prove the override flows into the config), a
 * watch-only env with no human slot (to prove a human assignment is rejected), and a four-slot,
 * all-human-capable, turn-based Hearts env (the multi-slot start-validation and attribution tests).
 */
export function makeEnvironments(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      meta({}),
      meta({ env_id: 'turn_based', pace_interval_ms: null, human_timeout_ms: 5000 }),
      meta({ env_id: 'watch_only', human_slots: [] }),
      meta({
        env_id: 'hearts',
        min_slots: 4,
        max_slots: 4,
        human_slots: ['player_0', 'player_1', 'player_2', 'player_3'],
        human_timeout_ms: 60000,
        pace_interval_ms: null,
        renderer: 'hearts',
        seat_order_matters: true,
      }),
      // A messaging-enabled partnership env (Spades-shaped) so the messaging-resolution tests have an
      // environment that opts in, with a metadata cap to combine against a season override.
      meta({
        env_id: 'chatty',
        min_slots: 4,
        max_slots: 4,
        human_slots: ['player_0', 'player_1', 'player_2', 'player_3'],
        human_timeout_ms: 60000,
        pace_interval_ms: null,
        messaging: true,
        message_cap: 120,
        renderer: 'spades',
        seat_order_matters: true,
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

/** Yield to the event loop so the relay's `for await` loop drains pushed lines. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A real-timer delay for the short idle/max-window tests. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
