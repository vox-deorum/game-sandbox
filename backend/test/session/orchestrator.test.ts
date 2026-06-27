import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureRecordingsDir } from '../../src/session/live-session.js'
import {
  Orchestrator,
  OrchestratorError,
  type SlotAssignment,
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
import { delay, flush, makeConfig, makeEnvironments } from '../support/harness.js'

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

/** Sugar for a single-slot assignment, the shape most start tests need. */
function slots(assignment: SlotAssignment): Record<string, SlotAssignment> {
  return { player_0: assignment }
}

/** A four-slot Hearts assignment defaulting to built-in agents, overridable per slot. */
function heartsSlots(
  overrides: Record<string, SlotAssignment> = {},
): Record<string, SlotAssignment> {
  return {
    player_0: { kind: 'builtin-agent' },
    player_1: { kind: 'builtin-agent' },
    player_2: { kind: 'builtin-agent' },
    player_3: { kind: 'builtin-agent' },
    ...overrides,
  }
}

/** A full start request with class defaults (alice, flappy_bird, one built-in slot), overridable. */
function startRequest(overrides: Partial<StartRequest> = {}): StartRequest {
  return {
    userId: 'alice',
    envId: 'flappy_bird',
    slots: slots({ kind: 'builtin-agent' }),
    ...overrides,
  }
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
    // Pair an (empty) snapshot store with the source whenever one is supplied: the rebuild path tries
    // the snapshot first, finds none here, and falls back to the source seam exactly as before.
    const snapshots =
      source === undefined
        ? undefined
        : new SubmissionSnapshotStore(join(recordingsDir, 'submissions'))
    return new Orchestrator(
      driver,
      storage,
      makeEnvironments(),
      config,
      undefined,
      undefined,
      source,
      snapshots,
    )
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
    await storage.ensureOpenSeason('flappy_bird', 1)
    await storage.ensureOpenSeason('turn_based', 1)
    await storage.ensureOpenSeason('hearts', 1)
  })

  afterEach(async () => {
    await storage.close()
    rmSync(recordingsDir, { recursive: true, force: true })
  })

  describe('start', () => {
    it('inserts a starting row and launches with the sandbox profile and config argv', async () => {
      const orch = makeOrchestrator()
      const { id, config } = await start(orch, { slots: slots({ kind: 'human' }), seed: 42 })

      const row = await storage.getSession(id)
      expect(row).toMatchObject({
        id,
        user_id: 'alice',
        env_id: 'flappy_bird',
        // A human slot makes the derived mode `human`.
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
      // The human slot is attributed to the session owner in the recording header.
      expect(config.players).toEqual({
        player_0: { kind: 'human', label: 'alice', user: 'alice' },
      })
    })

    it('binds the built-in agent for a scripted (watch) session', async () => {
      const { config } = await start(makeOrchestrator(), {
        slots: slots({ kind: 'builtin-agent' }),
      })
      expect(config.slots).toEqual({ player_0: { kind: 'builtin-agent' } })
      // A plain watch run attributes the slot to the built-in Naive agent.
      expect(config.players).toEqual({ player_0: { kind: 'agent', label: 'Naive agent' } })
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

    it('resolves the human-slot timeout: override wins, else metadata, else null', async () => {
      const orch1 = makeOrchestrator()
      const a = await start(orch1, {
        envId: 'turn_based',
        slots: slots({ kind: 'human' }),
        humanSlotTimeoutMs: 2000,
      })
      expect(a.config.human_timeout_ms).toBe(2000)

      driver = new FakeDriver()
      const orch2 = makeOrchestrator()
      const b = await start(orch2, { envId: 'turn_based', slots: slots({ kind: 'human' }) })
      expect(b.config.human_timeout_ms).toBe(5000)

      driver = new FakeDriver()
      const orch3 = makeOrchestrator()
      const c = await start(orch3, { envId: 'flappy_bird', slots: slots({ kind: 'human' }) })
      expect(c.config.human_timeout_ms).toBeNull()
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

    it('rejects an unknown environment and a human in a non-human-capable slot', async () => {
      const orch = makeOrchestrator()
      await expect(orch.start(startRequest({ userId: 'a', envId: 'nope' }))).rejects.toMatchObject({
        status: 400,
      })
      // watch_only marks no slot human-capable, so a human assignment there is rejected.
      await expect(
        orch.start(
          startRequest({ userId: 'c', envId: 'watch_only', slots: slots({ kind: 'human' }) }),
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })
  })

  describe('multi-slot Hearts start', () => {
    /** A Hearts start request: env defaulted, slots built from the four-seat defaults. */
    function startHearts(slots: Record<string, SlotAssignment>): StartRequest {
      return startRequest({ envId: 'hearts', slots })
    }

    it('rejects a payload missing a required seat before any container starts', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        // Only three of the four required seats assigned.
        orch.start(
          startHearts({
            player_0: { kind: 'builtin-agent' },
            player_1: { kind: 'builtin-agent' },
            player_2: { kind: 'builtin-agent' },
          }),
        ),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })

    it('rejects an unknown slot id', async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        orch.start(startHearts(heartsSlots({ player_9: { kind: 'builtin-agent' } }))),
      ).rejects.toMatchObject({ status: 400 })
      expect(driver.launches).toHaveLength(0)
    })

    it("rejects more than this stage's single human slot", async () => {
      const orch = makeOrchestrator(60_000, new FakeSource())
      await expect(
        orch.start(
          startHearts(heartsSlots({ player_0: { kind: 'human' }, player_1: { kind: 'human' } })),
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
          startHearts(heartsSlots({ player_0: { kind: 'submission', submissionId: foreign.id } })),
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
          startHearts(heartsSlots({ player_0: { kind: 'submission', submissionId: pending.id } })),
        ),
      ).rejects.toMatchObject({ status: 409, code: 'submission_not_ready' })
      expect(driver.launches).toHaveLength(0)
    })

    it('writes one session_submissions row per submitted slot, with human and built-in only in players', async () => {
      const source = new FakeSource()
      const orch = makeOrchestrator(60_000, source)
      const subA = await seedReadySubmission(storage, 'eve', 'hearts')
      const subB = await seedReadySubmission(storage, 'frank', 'hearts')

      const result = await orch.start(
        startHearts(
          heartsSlots({
            player_0: { kind: 'submission', submissionId: subA.id },
            player_1: { kind: 'submission', submissionId: subB.id },
            player_3: { kind: 'human' },
          }),
        ),
      )

      // A human slot present, so the derived mode is `human`, attributed to the hearts play season.
      const heartsSeason = await storage.getPublicPlaySeason('hearts')
      expect(await storage.getSession(result.id)).toMatchObject({
        mode: 'human',
        season_id: heartsSeason?.id,
      })

      // Exactly one attribution row per submitted slot; the built-in and human slots write none.
      const links = await storage.listSessionSubmissions(result.id)
      expect(
        links
          .map((l) => ({ slot_id: l.slot_id, submission_id: l.submission_id }))
          .sort((x, y) => x.slot_id.localeCompare(y.slot_id)),
      ).toEqual([
        { slot_id: 'player_0', submission_id: subA.id },
        { slot_id: 'player_1', submission_id: subB.id },
      ])

      const launch = driver.lastLaunch()
      const config = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        slots: Record<string, unknown>
        players: Record<string, unknown>
      }
      expect(config.slots).toEqual({
        player_0: { kind: 'builtin-agent', path: '/opt/agents/submissions/player_0' },
        player_1: { kind: 'builtin-agent', path: '/opt/agents/submissions/player_1' },
        player_2: { kind: 'builtin-agent' },
        player_3: { kind: 'external' },
      })
      // Built-in and human slots are represented only here in `players`, never as a link row.
      expect(config.players).toEqual({
        player_0: { kind: 'agent', label: "eve's agent", user: 'eve', submission_id: subA.id },
        player_1: { kind: 'agent', label: "frank's agent", user: 'frank', submission_id: subB.id },
        player_2: { kind: 'agent', label: 'Naive agent' },
        player_3: { kind: 'human', label: 'alice', user: 'alice' },
      })
      // The composed session image materialized one tree per submitted slot and disposed each.
      expect(source.fetchCount).toBe(2)
      expect(source.disposed).toBe(2)
      expect(launch?.spec.image.ref).toContain('session-overlay')
    })
  })

  describe('submitted-agent watch run', () => {
    /** A single-slot Flappy Bird watch of the given submission. */
    function watch(submissionId: string): StartRequest {
      return startRequest({ slots: slots({ kind: 'submission', submissionId }) })
    }

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

      const result = await orch.start(watch(submission.id))

      const launch = driver.lastLaunch()
      expect(launch?.spec.image.ref).toBe(overlayRef)
      const config = JSON.parse(launch?.spec.argv[0] ?? '{}') as {
        slots: Record<string, unknown>
        players: Record<string, unknown>
      }
      expect(config.slots).toEqual({
        player_0: { kind: 'builtin-agent', path: '/opt/agents/submissions/player_0' },
      })
      // The submitted-agent slot is attributed to the submission owner ('eve' from the seed helper).
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
      expect(overlaySpec).toMatchObject({ submissionId: submission.id, slotId: 'player_0' })
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
})
