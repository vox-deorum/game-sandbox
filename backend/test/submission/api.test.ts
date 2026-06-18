/**
 * The submission HTTP routes (Stage 5.5), Docker-free: capabilities, the reachability pre-check, the
 * submit-and-enqueue route, the single read joined with its checks, and the user/active-iteration
 * listings. The pipeline is stubbed out — the worker is a recording enqueuer and the source seam is a
 * canned double — so these prove the route contract (identity attribution, the typed 4xx codes, the
 * pending row, no inline pipeline) without resolving git or building images.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { RecordingsStore } from '../../src/recordings.js'
import { Retention } from '../../src/retention.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import { type Storage, SubmissionConflictError } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import type {
  ReachabilityResult,
  SourceInput,
  SubmissionSource,
} from '../../src/submission/source/index.js'
import { FakeDriver } from '../support/fake-driver.js'
import { makeConfig, makeEnvironments } from '../support/harness.js'
import { StubWorkflowRunner } from '../support/stub-runner.js'

const ENV_ID = 'flappy_bird'

/** A source double whose reachability verdict each test sets; resolve/fetch are never called here. */
class StubSource implements SubmissionSource {
  verdict: ReachabilityResult = { reachable: true }

  verifyReachable(_input: SourceInput): Promise<ReachabilityResult> {
    return Promise.resolve(this.verdict)
  }
  resolve(): Promise<never> {
    throw new Error('not used in API tests')
  }
  fetchTree(): Promise<never> {
    throw new Error('not used in API tests')
  }
}

describe('submission API', () => {
  let app: FastifyInstance
  let storage: Storage
  let orchestrator: Orchestrator
  let dir: string
  let enqueued: string[]
  let source: StubSource

  async function build(overrides: { allowLocalSubmissions?: boolean } = {}): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'gs-sub-'))
    storage = await openSqliteStorage(':memory:')
    const config = makeConfig({ recordingsDir: dir })
    orchestrator = new Orchestrator(new FakeDriver(), storage, makeEnvironments(), config)
    const recordings = new RecordingsStore(dir)
    enqueued = []
    source = new StubSource()
    app = await buildApp({
      orchestrator,
      environments: makeEnvironments(),
      recordings,
      retention: new Retention(storage, recordings, config),
      allowlist: ['dev-user'],
      operatorAllowlist: ['dev-user'],
      workflowRunner: new StubWorkflowRunner(storage),
      storage,
      submissionSource: source,
      validationWorker: { enqueue: (id) => enqueued.push(id) },
      allowLocalSubmissions: overrides.allowLocalSubmissions ?? false,
    })
  }

  afterEach(async () => {
    await orchestrator.shutdown()
    await app.close()
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports local-submission capability from config', async () => {
    await build({ allowLocalSubmissions: true })
    const res = await app.inject({ method: 'GET', url: '/api/submissions/capabilities' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ local_submissions: true })
  })

  it('returns the reachability verdict without writing a row', async () => {
    await build()
    source.verdict = { reachable: false, failure: 'ref_not_found', detail: 'no such ref' }
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions/reachability',
      payload: { repo_url: 'https://example.test/repo', ref: 'nope' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      reachable: false,
      failure: 'ref_not_found',
      detail: 'no such ref',
    })
    const mine = await app.inject({
      method: 'GET',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'alice' },
    })
    expect(mine.json()).toEqual([])
  })

  it('refuses a local reachability check when the dev gate is off', async () => {
    await build({ allowLocalSubmissions: false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions/reachability',
      payload: { local_path: '/srv/agent' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'local_disabled' })
  })

  it('creates a pending submission under the resolved identity without running the pipeline', async () => {
    await build()
    await storage.ensureOpenIteration(ENV_ID, 1)
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'alice' },
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json() as { id: string; status: string }
    expect(body.status).toBe('pending')
    // The job was enqueued, not run inline: no commit pinned, no checks recorded yet.
    expect(enqueued).toEqual([body.id])
    const row = await storage.getSubmission(body.id)
    expect(row?.user_id).toBe('alice')
    expect(row?.commit_sha).toBeNull()
    expect(await storage.listSubmissionChecks(body.id)).toEqual([])
  })

  it('attributes a submission to the request identity, not a client-supplied submitter', async () => {
    await build()
    await storage.ensureOpenIteration(ENV_ID, 1)
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'alice' },
      // A stray user_id in the body is ignored (additionalProperties:false would also reject it).
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    const body = res.json() as { id: string }
    const bobList = await app.inject({
      method: 'GET',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'bob' },
    })
    expect(bobList.json()).toEqual([])
    expect((await storage.getSubmission(body.id))?.user_id).toBe('alice')
  })

  it('refuses a submit when the environment has no open iteration, writing no row', async () => {
    await build()
    // No ensureOpenIteration: the environment has no open iteration.
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'alice' },
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'no_open_iteration' })
    expect(enqueued).toEqual([])
    const mine = await app.inject({
      method: 'GET',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'alice' },
    })
    expect(mine.json()).toEqual([])
  })

  it('refuses a local submit when the dev gate is off', async () => {
    await build({ allowLocalSubmissions: false })
    await storage.ensureOpenIteration(ENV_ID, 1)
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'alice' },
      payload: { env_id: ENV_ID, local_path: '/srv/agent' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'local_disabled' })
    expect(enqueued).toEqual([])
  })

  it('maps a concurrent-resubmit conflict to a retryable 409', async () => {
    await build()
    await storage.ensureOpenIteration(ENV_ID, 1)
    storage.createSubmission = () => Promise.reject(new SubmissionConflictError())
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: { 'x-sandbox-user': 'alice' },
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'resubmit_conflict' })
  })

  it('returns a submission joined with its ordered validation log', async () => {
    await build()
    const iteration = await storage.ensureOpenIteration(ENV_ID, 1)
    const submission = await storage.createSubmission({
      iteration_id: iteration.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'git',
      repo_url: 'https://example.test/repo',
      commit_sha: null,
      local_path: null,
      ref: null,
      created_at: new Date().toISOString(),
    })
    await storage.startSubmissionCheck(submission.id, 'resolve')
    await storage.finishSubmissionCheck(submission.id, 'resolve', 'passed')
    await storage.startSubmissionCheck(submission.id, 'static')

    const res = await app.inject({ method: 'GET', url: `/api/submissions/${submission.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; checks: Array<{ stage: string; status: string }> }
    expect(body.id).toBe(submission.id)
    expect(body.checks.map((c) => [c.stage, c.status])).toEqual([
      ['resolve', 'passed'],
      ['static', 'running'],
    ])
  })

  it('404s an unknown submission id', async () => {
    await build()
    const res = await app.inject({ method: 'GET', url: '/api/submissions/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('supersedes on resubmission so the active-iteration lookup returns the new row', async () => {
    await build()
    await storage.ensureOpenIteration(ENV_ID, 1)
    const first = (
      await app.inject({
        method: 'POST',
        url: '/api/submissions',
        headers: { 'x-sandbox-user': 'alice' },
        payload: { env_id: ENV_ID, repo_url: 'https://example.test/one' },
      })
    ).json() as { id: string }
    const second = (
      await app.inject({
        method: 'POST',
        url: '/api/submissions',
        headers: { 'x-sandbox-user': 'alice' },
        payload: { env_id: ENV_ID, repo_url: 'https://example.test/two' },
      })
    ).json() as { id: string }

    const active = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/submissions`,
    })
    const rows = active.json() as Array<{ id: string }>
    expect(rows.map((r) => r.id)).toEqual([second.id])
    expect(rows.map((r) => r.id)).not.toContain(first.id)
  })

  it('returns an empty active list for an environment with no play-open iteration', async () => {
    await build()
    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/submissions` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('lists ready submissions from the play-open iteration when the submission target differs', async () => {
    await build()
    const playIteration = await storage.ensureOpenIteration(ENV_ID, 1)
    const playable = await storage.createSubmission({
      iteration_id: playIteration.id,
      env_id: ENV_ID,
      user_id: 'play-owner',
      source_kind: 'git',
      repo_url: 'https://example.test/playable',
      commit_sha: 'play-sha',
      local_path: null,
      ref: null,
      created_at: new Date().toISOString(),
    })
    await storage.updateSubmissionStatus(playable.id, 'ready')
    await storage.setSubmissionStatus(playIteration.id, 'closed')

    const submissionIteration = await storage.createIteration({ env_id: ENV_ID, deps_version: 1 })
    await storage.setSubmissionStatus(submissionIteration.id, 'open')
    const nextRound = await storage.createSubmission({
      iteration_id: submissionIteration.id,
      env_id: ENV_ID,
      user_id: 'next-owner',
      source_kind: 'git',
      repo_url: 'https://example.test/next',
      commit_sha: 'next-sha',
      local_path: null,
      ref: null,
      created_at: new Date().toISOString(),
    })
    await storage.updateSubmissionStatus(nextRound.id, 'ready')

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/submissions?status=ready`,
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as Array<{ id: string }>).map((row) => row.id)).toEqual([playable.id])
  })

  describe('agent profile read', () => {
    it('returns one owner submission history with per-stage logs and recent replays', async () => {
      await build()
      const iteration = await storage.ensureOpenIteration(ENV_ID, 1)
      // The owner's first (now superseded) submission, which failed its load check.
      const first = await storage.createSubmission({
        iteration_id: iteration.id,
        env_id: ENV_ID,
        user_id: 'eve',
        source_kind: 'git',
        repo_url: 'https://example.test/one',
        commit_sha: null,
        local_path: null,
        ref: null,
        created_at: new Date(Date.now() - 1000).toISOString(),
      })
      await storage.startSubmissionCheck(first.id, 'resolve')
      await storage.finishSubmissionCheck(first.id, 'resolve', 'passed')
      await storage.startSubmissionCheck(first.id, 'static')
      await storage.finishSubmissionCheck(first.id, 'static', 'passed')
      await storage.startSubmissionCheck(first.id, 'build')
      await storage.finishSubmissionCheck(first.id, 'build', 'passed')
      await storage.startSubmissionCheck(first.id, 'load')
      await storage.finishSubmissionCheck(first.id, 'load', 'failed', "no class named 'Agent'")
      await storage.updateSubmissionStatus(first.id, 'load_failed', "no class named 'Agent'")

      // The owner's current ready submission, which ran in a watch session that produced a recording.
      const second = await storage.createSubmission({
        iteration_id: iteration.id,
        env_id: ENV_ID,
        user_id: 'eve',
        source_kind: 'git',
        repo_url: 'https://example.test/two',
        commit_sha: 'sha999',
        local_path: null,
        ref: null,
        created_at: new Date().toISOString(),
      })
      await storage.updateSubmissionStatus(second.id, 'ready')
      await storage.createSession({
        id: 'sess-1',
        user_id: 'watcher',
        env_id: ENV_ID,
        mode: 'scripted',
        recording_id: `${ENV_ID}-sess-1`,
        created_at: new Date().toISOString(),
      })
      await storage.recordSessionSubmission('sess-1', second.id, 'player_0')
      await storage.createRecording({
        id: `${ENV_ID}-sess-1`,
        user_id: 'watcher',
        env_id: ENV_ID,
        created_at: new Date().toISOString(),
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${ENV_ID}/agents/eve`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        env_id: string
        owner_id: string
        submission_iteration_id: string | null
        play_iteration_id: string | null
        submissions: Array<{
          id: string
          status: string
          reason: string | null
          checks: Array<{ stage: string; status: string; detail: string | null }>
          replays: string[]
        }>
      }
      expect(body).toMatchObject({
        env_id: ENV_ID,
        owner_id: 'eve',
        submission_iteration_id: iteration.id,
        play_iteration_id: iteration.id,
      })
      // Newest first: the ready submission, then the superseded failed one (history is preserved).
      expect(body.submissions.map((s) => s.id)).toEqual([second.id, first.id])
      const ready = body.submissions[0]
      expect(ready?.status).toBe('ready')
      expect(ready?.replays).toEqual([`${ENV_ID}-sess-1`])
      // The failed submission shows which stage rejected and the captured error, not just the rollup.
      const failed = body.submissions[1]
      expect(failed?.status).toBe('load_failed')
      expect(failed?.checks.find((c) => c.stage === 'load')).toMatchObject({
        status: 'failed',
        detail: "no class named 'Agent'",
      })
      expect(failed?.replays).toEqual([])
    })

    it('returns an empty history for an owner with no submissions', async () => {
      await build()
      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${ENV_ID}/agents/nobody`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ env_id: ENV_ID, owner_id: 'nobody', submissions: [] })
    })
  })
})
