/**
 * Stand up the real backend stack for an integration test: the Docker driver, storage, the
 * orchestrator, and the Fastify app listening on an ephemeral port. This is the production wiring
 * from `main.ts`, minus signal handling, against the already-built session base image.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildApp } from '../../../src/app.js'
import { createUserDirectory } from '../../../src/auth/users.js'
import { KNOWN_DEPS_VERSIONS } from '../../../src/build/deps-version.js'
import type { Config } from '../../../src/config/config.js'
import { createDockerDriver } from '../../../src/driver/docker/index.js'
import { EnvironmentRegistry } from '../../../src/environments/registry.js'
import { Retention } from '../../../src/recordings/retention.js'
import { RecordingsStore } from '../../../src/recordings/store.js'
import { Orchestrator } from '../../../src/session/orchestrator.js'
import type { Storage } from '../../../src/storage/index.js'
import { openSqlite } from '../../../src/storage/sqlite.js'
import { SubmissionSnapshotStore } from '../../../src/submission/snapshot-store.js'
import { createSubmissionSource } from '../../../src/submission/source/index.js'
import { ValidationWorker } from '../../../src/submission/worker.js'
import { makeTestAuth, type TestUsers } from '../../support/auth.js'
import { TEST_AUTH_OPTIONS } from '../../support/auth-options.js'
import { makeTestLlmOptions } from '../../support/llm-options.js'
import { StubWorkflowRunner } from '../../support/stub-runner.js'

export interface Stack {
  httpBase: string
  wsBase: string
  orchestrator: Orchestrator
  storage: Storage
  recordings: RecordingsStore
  recordingsDir: string
  /** Mints real signed-in users; `startSession`/`stopSession` send their session cookie. */
  users: TestUsers
  close(): Promise<void>
}

export async function startStack(overrides: Partial<Config> = {}): Promise<Stack> {
  const recordingsDir = mkdtempSync(join(tmpdir(), 'gs-it-'))
  const config: Config = {
    port: 0,
    listenHost: '127.0.0.1',
    siteName: 'Game Sandbox',
    siteShortName: 'Game Sandbox',
    templateRepoUrl: 'https://github.com/vox-deorum/game-agent-template',
    dataDir: recordingsDir,
    dbPath: ':memory:',
    recordingsDir,
    submissionsDir: join(recordingsDir, 'submissions'),
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

  const { storage, sqlite } = await openSqlite(':memory:')
  const { auth, users } = await makeTestAuth(sqlite)
  const environments = EnvironmentRegistry.load()
  // A plain public session attaches to its environment's play-open season; seed one per environment
  // (the seed season is both submission- and play-open) so the start routes behave as in production.
  for (const meta of environments.list()) {
    await storage.ensureOpenSeason(meta.env_id, 1)
  }
  const driver = await createDockerDriver(config.docker)
  const recordings = new RecordingsStore(resolve(recordingsDir))
  const retention = new Retention(storage, recordings, config)
  const submissionSource = createSubmissionSource(config.submission)
  const snapshots = new SubmissionSnapshotStore(resolve(config.submissionsDir))
  const userDirectory = createUserDirectory(sqlite)
  // Wire the submission source, snapshot store, and user directory into the orchestrator, as
  // main.ts does, so a submitted-agent (and multi-agent) session can resolve its overlay/composed
  // image and its recording-header attribution can resolve owner display names.
  const orchestrator = new Orchestrator({
    driver,
    storage,
    environments,
    config,
    onSessionFinalized: () => {
      void retention.sweep()
    },
    submissionSource,
    submissionSnapshots: snapshots,
    userDirectory,
  })
  const validationWorker = new ValidationWorker({
    driver,
    storage,
    source: submissionSource,
    snapshots,
    submissionMaxSizeBytes: config.submission.submissionMaxSizeBytes,
    sandbox: config.sandbox,
    loadCheckTimeoutMs: config.submission.loadCheckTimeoutMs,
    knownTemplateVersions: new Set([1]),
  })
  const app = await buildApp({
    orchestrator,
    environments,
    recordings,
    retention,
    auth,
    userDirectory,
    knownDepsVersions: KNOWN_DEPS_VERSIONS,
    workflowRunner: new StubWorkflowRunner(storage),
    storage,
    submissionSource,
    submissionSnapshots: snapshots,
    validationWorker,
    allowLocalSubmissions: config.submission.allowLocalSubmissions,
    docsDir: config.docsDir,
    llm: config.llm,
    templateRepoUrl: config.templateRepoUrl,
  })

  const httpBase = await app.listen({ port: 0, host: '127.0.0.1' })

  return {
    httpBase,
    wsBase: httpBase.replace(/^http/, 'ws'),
    orchestrator,
    storage,
    recordings,
    recordingsDir,
    users,
    async close(): Promise<void> {
      await orchestrator.shutdown()
      await app.close()
      await storage.close()
      rmSync(recordingsDir, { recursive: true, force: true })
    },
  }
}

/** POST /api/sessions and return the created session id and websocket path. */
export async function startSession(
  stack: Stack,
  body: {
    env_id: string
    seats: Record<
      string,
      {
        kind: 'human' | 'builtin-agent' | 'submission'
        submission_id?: string
        name?: string
        companion?: { kind: 'builtin-agent' | 'submission'; submission_id?: string; name?: string }
      }
    >
    parameters?: Record<string, unknown>
    seed?: number
    human_timeout_ms?: number
  },
  user = 'dev-user',
): Promise<{ id: string; wsPath: string }> {
  const auth = await stack.users.headersFor(user)
  const prefill = await fetch(`${stack.httpBase}/api/environments/${body.env_id}/play-parameters`)
  const context = (await prefill.json()) as {
    season_id: string | null
    values: Record<string, unknown>
  }
  const response = await fetch(`${stack.httpBase}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({
      ...body,
      season_id: context.season_id,
      parameters: { ...context.values, ...body.parameters },
    }),
  })
  if (response.status !== 201) {
    throw new Error(`start session failed: ${response.status} ${await response.text()}`)
  }
  const json = (await response.json()) as { id: string; ws_path: string }
  return { id: json.id, wsPath: json.ws_path }
}

export interface SessionRow {
  id: string
  status: string
  termination_reason: string | null
  recording_id: string | null
}

/** GET the session row, or undefined when the id is unknown. */
export async function getSessionRow(stack: Stack, id: string): Promise<SessionRow | undefined> {
  const response = await fetch(`${stack.httpBase}/api/sessions/${id}`)
  return response.status === 200 ? ((await response.json()) as SessionRow) : undefined
}

/** Owner DELETE; resolves once the request is accepted. */
export async function stopSession(stack: Stack, id: string, user = 'dev-user'): Promise<void> {
  const auth = await stack.users.headersFor(user)
  await fetch(`${stack.httpBase}/api/sessions/${id}`, {
    method: 'DELETE',
    headers: auth,
  })
}

/** Poll the row until it reaches `ended`, returning it; throws on timeout. */
export async function waitForEnded(
  stack: Stack,
  id: string,
  timeoutMs = 30_000,
): Promise<SessionRow> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await getSessionRow(stack, id)
    if (row?.status === 'ended') {
      return row
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`session ${id} did not end within ${timeoutMs}ms`)
}
