/**
 * Shared scaffolding for the orchestrator, relay, and HTTP suites: a config builder, a controlled
 * environment registry, a fake browser socket, and microtask/timer helpers. No Docker, no Python —
 * everything runs against the {@link FakeDriver} and in-memory SQLite.
 */
import type { Config } from '../../src/config.js'
import type { ExecutionDriver } from '../../src/driver/index.js'
import { EnvironmentRegistry } from '../../src/environments.js'
import type { ClientSocket } from '../../src/session/live-session.js'
import type { Storage } from '../../src/storage/index.js'
import {
  createSubmissionSource,
  type SubmissionSourceDeps,
} from '../../src/submission/source/index.js'
import { ValidationWorker } from '../../src/submission/worker.js'
import { FakeDriver } from './fake-driver.js'

/** A config with class-scale defaults overridable per test (e.g. a tiny idle window). */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    dataDir: './data',
    dbPath: ':memory:',
    recordingsDir: './data/recordings',
    sessionIdleTimeoutMs: 60_000,
    sessionMaxDurationMs: 600_000,
    // The identities the start-succeeding suites use; allowlist tests override this explicitly.
    sessionAllowlist: ['dev-user', 'alice', 'bob'],
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
    submission: { allowLocalSubmissions: false, gitTimeoutMs: 15_000, loadCheckTimeoutMs: 30_000 },
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
  } = {},
): {
  storage: Storage
  submissionSource: ReturnType<typeof createSubmissionSource>
  validationWorker: ValidationWorker
  allowLocalSubmissions: boolean
} {
  const driver = options.driver ?? new FakeDriver()
  const submissionSource = createSubmissionSource(config.submission, options.source)
  const validationWorker = new ValidationWorker({
    driver,
    storage,
    source: submissionSource,
    sandbox: config.sandbox,
    loadCheckTimeoutMs: config.submission.loadCheckTimeoutMs,
    knownTemplateVersions: options.knownTemplateVersions ?? new Set([1]),
  })
  return {
    storage,
    submissionSource,
    validationWorker,
    allowLocalSubmissions: config.submission.allowLocalSubmissions,
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
    ...overrides,
  }
}

/**
 * A controlled registry with three shapes the tests need: the paced single-human Flappy env, a
 * turn-based env with a metadata human timeout (to prove the override flows into the config), and a
 * watch-only env with no human slot (to prove human mode is rejected).
 */
export function makeEnvironments(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      meta({}),
      meta({ env_id: 'turn_based', pace_interval_ms: null, human_timeout_ms: 5000 }),
      meta({ env_id: 'watch_only', human_slots: [] }),
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
