import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureRecordingsDir } from '../src/session/live-session.js'
import { Orchestrator, OrchestratorError } from '../src/session/orchestrator.js'
import type { Storage, Submission } from '../src/storage/index.js'
import type { SessionMode } from '../src/storage/schema.js'
import { openSqliteStorage } from '../src/storage/sqlite.js'
import type {
  ResolvedSource,
  SourceInput,
  SubmissionSource,
  TreeHandle,
} from '../src/submission/source/index.js'
import { FakeDriver, type FakeSessionProcess } from './support/fake-driver.js'
import { delay, flush, makeConfig, makeEnvironments } from './support/harness.js'

/**
 * A submission-source double for the submitted-agent watch path. Records the inputs it resolves and
 * fetches, and tracks whether the materialized tree was disposed, so a test can assert the overlay
 * rebuild path refetched the pinned source and cleaned up its checkout.
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

/** Seed a `ready` Flappy Bird submission for `userId` on the env's open iteration. */
async function seedReadySubmission(storage: Storage, userId = 'eve'): Promise<Submission> {
  const iteration = await storage.ensureOpenIteration('flappy_bird', 1)
  const submission = await storage.createSubmission({
    iteration_id: iteration.id,
    env_id: 'flappy_bird',
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

const HEADER = '{"schema_version":1,"environment":"flappy_bird","seed":0}'
const STATE = '{"schema_version":1,"tick":0,"agents":{},"timing":{"started_at":1,"duration_ms":1}}'

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

  function makeOrchestrator(idleMs = 60_000, source?: SubmissionSource): Orchestrator {
    const config = makeConfig({ recordingsDir, sessionIdleTimeoutMs: idleMs })
    return new Orchestrator(
      driver,
      storage,
      makeEnvironments(),
      config,
      undefined,
      undefined,
      source,
    )
  }

  async function start(
    orch: Orchestrator,
    overrides: Partial<{
      userId: string
      envId: string
      mode: SessionMode
      seed: number
      humanSlotTimeoutMs: number
    }> = {},
  ): Promise<{ id: string; process: FakeSessionProcess; config: Record<string, unknown> }> {
    const result = await orch.start({
      userId: 'alice',
      envId: 'flappy_bird',
      mode: 'scripted',
      ...overrides,
    })
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
  })

  afterEach(async () => {
    await storage.close()
    rmSync(recordingsDir, { recursive: true, force: true })
  })

  describe('start', () => {
    it('inserts a starting row and launches with the sandbox profile and config argv', async () => {
      const orch = makeOrchestrator()
      const { id, config } = await start(orch, { mode: 'human', seed: 42 })

      const row = await storage.getSession(id)
      expect(row).toMatchObject({
        id,
        user_id: 'alice',
        env_id: 'flappy_bird',
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
      })
      expect(launch?.spec.sandbox.mounts[0]).toMatchObject({
        containerPath: '/recordings',
        readOnly: false,
      })
      expect(config).toMatchObject({
        env_id: 'flappy_bird',
        seed: 42,
        slots: { player_0: { kind: 'external' } },
        recording_dir: '/recordings',
        recording_id: `flappy_bird-${id}`,
      })
    })

    it('binds the built-in agent for a scripted (watch) session', async () => {
      const { config } = await start(makeOrchestrator(), { mode: 'scripted' })
      expect(config.slots).toEqual({ player_0: { kind: 'builtin-agent' } })
    })

    it('prepares the recording volume for the cap-dropped session container', async () => {
      const nested = join(recordingsDir, 'nested')
      await ensureRecordingsDir(nested)
      if (process.platform !== 'win32') {
        expect(statSync(nested).mode & 0o777).toBe(0o777)
      }
    })

    it('resolves the human-slot timeout: override wins, else metadata, else null', async () => {
      const orch1 = makeOrchestrator()
      const a = await start(orch1, { envId: 'turn_based', mode: 'human', humanSlotTimeoutMs: 2000 })
      expect(a.config.human_timeout_ms).toBe(2000)

      driver = new FakeDriver()
      const orch2 = makeOrchestrator()
      const b = await start(orch2, { envId: 'turn_based', mode: 'human' })
      expect(b.config.human_timeout_ms).toBe(5000)

      driver = new FakeDriver()
      const orch3 = makeOrchestrator()
      const c = await start(orch3, { envId: 'flappy_bird', mode: 'human' })
      expect(c.config.human_timeout_ms).toBeNull()
    })

    it('rejects a second concurrent session for the same user with 409', async () => {
      const orch = makeOrchestrator()
      await start(orch)
      await expect(
        orch.start({ userId: 'alice', envId: 'flappy_bird', mode: 'scripted' }),
      ).rejects.toMatchObject({ status: 409 })
    })

    it('lets a different user start concurrently', async () => {
      const orch = makeOrchestrator()
      await start(orch, { userId: 'alice' })
      await expect(
        orch.start({ userId: 'bob', envId: 'flappy_bird', mode: 'scripted' }),
      ).resolves.toBeDefined()
    })

    it('rejects an unknown environment, an invalid mode, and human mode without a human slot', async () => {
      const orch = makeOrchestrator()
      await expect(
        orch.start({ userId: 'a', envId: 'nope', mode: 'scripted' }),
      ).rejects.toMatchObject({ status: 400 })
      await expect(
        orch.start({ userId: 'b', envId: 'flappy_bird', mode: 'spectate' as SessionMode }),
      ).rejects.toMatchObject({ status: 400 })
      await expect(
        orch.start({ userId: 'c', envId: 'watch_only', mode: 'human' }),
      ).rejects.toMatchObject({ status: 400 })
    })
  })

  describe('submitted-agent watch run', () => {
    it('launches from the submission overlay image and binds the agent slot to its path', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const submission = await seedReadySubmission(storage)
      // The build stage already produced the overlay and the eviction sweep exempts it; under the
      // default `reuse` policy the watch run finds the cached image without refetching the source.
      const overlayRef = `game-sandbox/submission-overlay:deps-v1-${submission.id}`
      driver.overlayImages.set(overlayRef, {
        ref: overlayRef,
        submissionId: submission.id,
        createdAtMs: 1,
      })

      const result = await orch.start({
        userId: 'alice',
        envId: 'flappy_bird',
        mode: 'scripted',
        submissionId: submission.id,
      })

      const launch = driver.lastLaunch()
      expect(launch?.spec.image.ref).toBe(overlayRef)
      const config = JSON.parse(launch?.spec.argv[0] ?? '{}') as { slots: Record<string, unknown> }
      expect(config.slots).toEqual({
        player_0: { kind: 'builtin-agent', path: '/opt/agents/submissions/player_0' },
      })
      // The reuse path never touched the source seam.
      expect(source.fetchCount).toBe(0)
      // The session is recorded as scripted and tied to the submission for profile history.
      expect((await storage.getSession(result.id))?.mode).toBe('scripted')
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

      await orch.start({
        userId: 'alice',
        envId: 'flappy_bird',
        mode: 'scripted',
        submissionId: submission.id,
      })

      expect(source.resolved).toHaveLength(1)
      expect(source.resolved[0]).toMatchObject({
        kind: 'git',
        repoUrl: 'https://example.test/agent',
        ref: 'sha123',
      })
      expect(source.fetchCount).toBe(1)
      expect(source.disposed).toBe(1)
      const overlaySpec = driver.imageRequests.find((spec) => spec.kind === 'submission-overlay')
      expect(overlaySpec).toMatchObject({ submissionId: submission.id, slotId: 'player_0' })
      const launch = driver.lastLaunch()
      expect(launch?.spec.image.ref).toContain(submission.id)
    })

    it('refuses to run a non-ready submission with 409', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const iteration = await storage.ensureOpenIteration('flappy_bird', 1)
      const submission = await storage.createSubmission({
        iteration_id: iteration.id,
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
      await expect(
        orch.start({
          userId: 'alice',
          envId: 'flappy_bird',
          mode: 'scripted',
          submissionId: submission.id,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'submission_not_ready' })
      expect(driver.launches).toHaveLength(0)
    })

    it('refuses a submission that is not for the open iteration', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const submission = await seedReadySubmission(storage)
      // Resubmitting supersedes the ready row, so it is no longer the active open-iteration submission.
      const iteration = await storage.getOpenIteration('flappy_bird')
      await storage.createSubmission({
        iteration_id: iteration?.id ?? '',
        env_id: 'flappy_bird',
        user_id: 'eve',
        source_kind: 'git',
        repo_url: 'https://example.test/agent-2',
        commit_sha: null,
        local_path: null,
        ref: null,
        created_at: new Date().toISOString(),
      })
      await expect(
        orch.start({
          userId: 'alice',
          envId: 'flappy_bird',
          mode: 'scripted',
          submissionId: submission.id,
        }),
      ).rejects.toMatchObject({ status: 409, code: 'submission_not_active' })
    })

    it('refuses a human-mode submission run as a malformed request', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const submission = await seedReadySubmission(storage)
      await expect(
        orch.start({
          userId: 'alice',
          envId: 'flappy_bird',
          mode: 'human',
          submissionId: submission.id,
        }),
      ).rejects.toMatchObject({ status: 400 })
    })

    it('404s an unknown submission id', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        orch.start({
          userId: 'alice',
          envId: 'flappy_bird',
          mode: 'scripted',
          submissionId: 'no-such-id',
        }),
      ).rejects.toMatchObject({ status: 404 })
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
      await expect(
        orch.start({ userId: 'alice', envId: 'flappy_bird', mode: 'scripted' }),
      ).resolves.toBeDefined()
    })

    it('marks the row running when the header arrives', async () => {
      const orch = makeOrchestrator()
      const { id, process } = await start(orch)
      process.emit(HEADER)
      await flush()
      expect((await storage.getSession(id))?.status).toBe('running')
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
      await expect(
        orch.start({ userId: 'alice', envId: 'flappy_bird', mode: 'scripted' }),
      ).resolves.toBeDefined()
    })
  })

  it('exposes OrchestratorError with a status for the HTTP layer to map', async () => {
    const orch = makeOrchestrator()
    const error = await orch.start({ userId: 'a', envId: 'nope', mode: 'scripted' }).catch((e) => e)
    expect(error).toBeInstanceOf(OrchestratorError)
    expect(error.status).toBe(400)
  })
})
