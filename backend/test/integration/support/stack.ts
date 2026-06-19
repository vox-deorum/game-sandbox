/**
 * Stand up the real backend stack for an integration test: the Docker driver, storage, the
 * orchestrator, and the Fastify app listening on an ephemeral port. This is the production wiring
 * from `main.ts`, minus signal handling, against the already-built session base image.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildApp } from '../../../src/app.js'
import type { Config } from '../../../src/config.js'
import { createDockerDriver } from '../../../src/driver/docker/index.js'
import { EnvironmentRegistry } from '../../../src/environments.js'
import { RecordingsStore } from '../../../src/recordings.js'
import { Retention } from '../../../src/retention.js'
import { Orchestrator } from '../../../src/session/orchestrator.js'
import type { Storage } from '../../../src/storage/index.js'
import { openSqliteStorage } from '../../../src/storage/sqlite.js'
import { createSubmissionSource } from '../../../src/submission/source/index.js'
import { ValidationWorker } from '../../../src/submission/worker.js'
import { createPlaceholderRunner } from '../../../src/workflow/runner.js'

export interface Stack {
  httpBase: string
  wsBase: string
  orchestrator: Orchestrator
  storage: Storage
  recordings: RecordingsStore
  recordingsDir: string
  close(): Promise<void>
}

export async function startStack(overrides: Partial<Config> = {}): Promise<Stack> {
  const recordingsDir = mkdtempSync(join(tmpdir(), 'gs-it-'))
  const config: Config = {
    port: 0,
    dataDir: recordingsDir,
    dbPath: ':memory:',
    recordingsDir,
    sessionIdleTimeoutMs: 60_000,
    sessionMaxDurationMs: 600_000,
    sessionAllowlist: ['dev-user', 'alice', 'bob', 'carol'],
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
    submission: { allowLocalSubmissions: false, gitTimeoutMs: 15_000, loadCheckTimeoutMs: 30_000 },
    ...overrides,
  }

  const storage = await openSqliteStorage(':memory:')
  const environments = EnvironmentRegistry.load()
  // A plain public session attaches to its environment's play-open season; seed one per environment
  // (the seed season is both submission- and play-open) so the start routes behave as in production.
  for (const meta of environments.list()) {
    await storage.ensureOpenSeason(meta.env_id, 1)
  }
  const driver = await createDockerDriver(config.docker)
  const recordings = new RecordingsStore(resolve(recordingsDir))
  const retention = new Retention(storage, recordings, config)
  const orchestrator = new Orchestrator(
    driver,
    storage,
    environments,
    config,
    () => {},
    () => {
      void retention.sweep()
    },
  )
  const submissionSource = createSubmissionSource(config.submission)
  const validationWorker = new ValidationWorker({
    driver,
    storage,
    source: submissionSource,
    sandbox: config.sandbox,
    loadCheckTimeoutMs: config.submission.loadCheckTimeoutMs,
    knownTemplateVersions: new Set([1]),
  })
  const app = await buildApp({
    orchestrator,
    environments,
    recordings,
    retention,
    allowlist: config.sessionAllowlist,
    operatorAllowlist: config.operatorAllowlist,
    workflowRunner: createPlaceholderRunner(storage),
    storage,
    submissionSource,
    validationWorker,
    allowLocalSubmissions: config.submission.allowLocalSubmissions,
  })

  const httpBase = await app.listen({ port: 0, host: '127.0.0.1' })

  return {
    httpBase,
    wsBase: httpBase.replace(/^http/, 'ws'),
    orchestrator,
    storage,
    recordings,
    recordingsDir,
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
    mode: 'human' | 'scripted'
    seed?: number
    human_slot_timeout_ms?: number
  },
  user = 'dev-user',
): Promise<{ id: string; wsPath: string }> {
  const response = await fetch(`${stack.httpBase}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sandbox-user': user },
    body: JSON.stringify(body),
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
  await fetch(`${stack.httpBase}/api/sessions/${id}`, {
    method: 'DELETE',
    headers: { 'x-sandbox-user': user },
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
