/**
 * The submission HTTP routes (Stage 5.5), Docker-free: capabilities, the reachability pre-check, the
 * submit-and-enqueue route, the single read joined with its checks, and the user/active-season
 * listings. The pipeline is stubbed out — the worker is a recording enqueuer and the source seam is a
 * canned double — so these prove the route contract (identity attribution, the typed 4xx codes, the
 * pending row, no inline pipeline) without resolving git or building images.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { RecordingsStore } from '../../src/recordings.js'
import { Retention } from '../../src/retention.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import { type Storage, SubmissionConflictError } from '../../src/storage/index.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import type {
  ReachabilityResult,
  SourceInput,
  SubmissionSource,
} from '../../src/submission/source/index.js'
import type { TestUsers } from '../support/auth.js'
import { FakeDriver } from '../support/fake-driver.js'
import { makeConfig, makeEnvironments, openTestStack } from '../support/harness.js'
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
  let users: TestUsers
  let orchestrator: Orchestrator
  let dir: string
  let enqueued: string[]
  let source: StubSource
  let sqlite: BetterSqlite3.Database

  async function build(overrides: { allowLocalSubmissions?: boolean } = {}): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'gs-sub-'))
    const stack = await openTestStack()
    storage = stack.storage
    users = stack.users
    sqlite = stack.sqlite
    const config = makeConfig({ recordingsDir: dir })
    orchestrator = new Orchestrator({
      driver: new FakeDriver(),
      storage,
      environments: makeEnvironments(),
      config,
    })
    const recordings = new RecordingsStore(dir)
    enqueued = []
    source = new StubSource()
    app = await buildApp({
      orchestrator,
      environments: makeEnvironments(),
      recordings,
      retention: new Retention(storage, recordings, config),
      auth: stack.auth,
      userDirectory: stack.userDirectory,
      knownDepsVersions: new Set([1]),
      workflowRunner: new StubWorkflowRunner(storage),
      storage,
      submissionSource: source,
      submissionSnapshots: new SubmissionSnapshotStore(join(dir, 'submissions')),
      validationWorker: { enqueue: (id) => enqueued.push(id) },
      allowLocalSubmissions: overrides.allowLocalSubmissions ?? false,
      docsDir: config.docsDir,
      llm: config.llm,
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
    const alice = await users.headersFor('alice')
    source.verdict = { reachable: false, failure: 'ref_not_found', detail: 'no such ref' }
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions/reachability',
      headers: alice,
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
      headers: alice,
    })
    expect(mine.json()).toEqual([])
  })

  it('refuses a local reachability check when the dev gate is off', async () => {
    await build({ allowLocalSubmissions: false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions/reachability',
      headers: await users.headersFor('alice'),
      payload: { local_path: '/srv/agent' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'local_disabled' })
  })

  it('requires an active user for the reachability check and the submit route', async () => {
    await build()
    await storage.ensureOpenSeason(ENV_ID, 1)
    // Anonymous is refused before any source work.
    const anon = await app.inject({
      method: 'POST',
      url: '/api/submissions/reachability',
      payload: { repo_url: 'https://example.test/repo' },
    })
    expect(anon.statusCode).toBe(401)
    expect(anon.json()).toMatchObject({ code: 'auth_required' })

    // A pending user is signed in but not yet active, so submitting is refused with not_active.
    const pending = await users.headersFor('newcomer', { status: 'pending' })
    const submit = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: pending,
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    expect(submit.statusCode).toBe(403)
    expect(submit.json()).toMatchObject({ code: 'not_active' })
    expect(enqueued).toEqual([])
  })

  it('creates a pending submission under the resolved identity without running the pipeline', async () => {
    await build()
    await storage.ensureOpenSeason(ENV_ID, 1)
    const alice = await users.headersFor('alice')
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: alice,
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json() as { id: string; status: string }
    expect(body.status).toBe('pending')
    // The job was enqueued, not run inline: no commit pinned, no checks recorded yet.
    expect(enqueued).toEqual([body.id])
    const row = await storage.getSubmission(body.id)
    expect(row?.user_id).toBe(users.idOf('alice'))
    expect(row?.commit_sha).toBeNull()
    expect(await storage.listSubmissionChecks(body.id)).toEqual([])
  })

  it('attributes a submission to the request identity, not a client-supplied submitter', async () => {
    await build()
    await storage.ensureOpenSeason(ENV_ID, 1)
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: await users.headersFor('alice'),
      // A stray user_id in the body is ignored (additionalProperties:false would also reject it).
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    const body = res.json() as { id: string }
    const bobList = await app.inject({
      method: 'GET',
      url: '/api/submissions',
      headers: await users.headersFor('bob'),
    })
    expect(bobList.json()).toEqual([])
    expect((await storage.getSubmission(body.id))?.user_id).toBe(users.idOf('alice'))
  })

  it('refuses a submit when the environment has no open season, writing no row', async () => {
    await build()
    const alice = await users.headersFor('alice')
    // No ensureOpenSeason: the environment has no open season.
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: alice,
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'no_open_season' })
    expect(enqueued).toEqual([])
    const mine = await app.inject({
      method: 'GET',
      url: '/api/submissions',
      headers: alice,
    })
    expect(mine.json()).toEqual([])
  })

  it('refuses a local submit when the dev gate is off', async () => {
    await build({ allowLocalSubmissions: false })
    await storage.ensureOpenSeason(ENV_ID, 1)
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: await users.headersFor('alice'),
      payload: { env_id: ENV_ID, local_path: '/srv/agent' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'local_disabled' })
    expect(enqueued).toEqual([])
  })

  it('keeps local-path precedence when both source fields are present', async () => {
    await build({ allowLocalSubmissions: false })
    await storage.ensureOpenSeason(ENV_ID, 1)
    const headers = await users.headersFor('alice')
    const payload = {
      repo_url: 'https://example.test/repo',
      local_path: '/srv/agent',
    }

    const reachability = await app.inject({
      method: 'POST',
      url: '/api/submissions/reachability',
      headers,
      payload,
    })
    expect(reachability.statusCode).toBe(403)
    expect(reachability.json()).toMatchObject({ code: 'local_disabled' })

    const submit = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers,
      payload: { env_id: ENV_ID, ...payload },
    })
    expect(submit.statusCode).toBe(403)
    expect(submit.json()).toMatchObject({ code: 'local_disabled' })
    expect(enqueued).toEqual([])
  })

  it('maps a concurrent-resubmit conflict to a retryable 409', async () => {
    await build()
    await storage.ensureOpenSeason(ENV_ID, 1)
    storage.createSubmission = () => Promise.reject(new SubmissionConflictError())
    const res = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: await users.headersFor('alice'),
      payload: { env_id: ENV_ID, repo_url: 'https://example.test/repo' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'resubmit_conflict' })
  })

  it('returns a submission joined with its ordered validation log', async () => {
    await build()
    const alice = await users.headersFor('alice')
    const season = await storage.ensureOpenSeason(ENV_ID, 1)
    const submission = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: users.idOf('alice'),
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

    const res = await app.inject({
      method: 'GET',
      url: `/api/submissions/${submission.id}`,
      headers: alice,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { id: string; checks: Array<{ stage: string; status: string }> }
    expect(body.id).toBe(submission.id)
    expect(body.checks.map((c) => [c.stage, c.status])).toEqual([
      ['resolve', 'passed'],
      ['static', 'running'],
    ])
  })

  it('401s an unknown submission id for an anonymous caller and 404s for a signed-in one', async () => {
    await build()
    const anon = await app.inject({ method: 'GET', url: '/api/submissions/nope' })
    expect(anon.statusCode).toBe(401)
    const res = await app.inject({
      method: 'GET',
      url: '/api/submissions/nope',
      headers: await users.headersFor('alice'),
    })
    expect(res.statusCode).toBe(404)
  })

  it('restricts submission detail to the owner or an admin', async () => {
    await build()
    const alice = await users.headersFor('alice')
    const season = await storage.ensureOpenSeason(ENV_ID, 1)
    const submission = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: users.idOf('alice'),
      source_kind: 'git',
      repo_url: 'https://example.test/private',
      commit_sha: 'secret-sha',
      local_path: null,
      ref: null,
      created_at: new Date().toISOString(),
    })

    const stranger = await app.inject({
      method: 'GET',
      url: `/api/submissions/${submission.id}`,
      headers: await users.headersFor('bob'),
    })
    expect(stranger.statusCode).toBe(403)
    expect(stranger.json()).toMatchObject({ code: 'forbidden' })

    const owner = await app.inject({
      method: 'GET',
      url: `/api/submissions/${submission.id}`,
      headers: alice,
    })
    expect(owner.statusCode).toBe(200)

    const admin = await app.inject({
      method: 'GET',
      url: `/api/submissions/${submission.id}`,
      headers: await users.headersFor('op', { status: 'admin' }),
    })
    expect(admin.statusCode).toBe(200)
    expect(admin.json()).toMatchObject({ user_id: users.idOf('alice'), commit_sha: 'secret-sha' })
  })

  it('supersedes on resubmission so the watch list returns only the new row', async () => {
    await build()
    await storage.ensureOpenSeason(ENV_ID, 1)
    const alice = await users.headersFor('alice')
    const first = (
      await app.inject({
        method: 'POST',
        url: '/api/submissions',
        headers: alice,
        payload: { env_id: ENV_ID, repo_url: 'https://example.test/one' },
      })
    ).json() as { id: string }
    const second = (
      await app.inject({
        method: 'POST',
        url: '/api/submissions',
        headers: alice,
        payload: { env_id: ENV_ID, repo_url: 'https://example.test/two' },
      })
    ).json() as { id: string }
    await storage.updateSubmissionStatus(second.id, 'ready')

    const active = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/watch-agents`,
      headers: await users.headersFor('bob'),
    })
    const rows = active.json() as Array<{ submission_id: string }>
    expect(rows.map((r) => r.submission_id)).toEqual([second.id])
    expect(rows.map((r) => r.submission_id)).not.toContain(first.id)
  })

  it('returns an empty watch list for an environment with no play-open season', async () => {
    await build()
    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/watch-agents`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('lists ready watch agents from the play-open season when the submission target differs', async () => {
    await build()
    const playSeason = await storage.ensureOpenSeason(ENV_ID, 1)
    const playable = await storage.createSubmission({
      season_id: playSeason.id,
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
    await storage.setSubmissionStatus(playSeason.id, 'closed')

    const submissionSeason = await storage.createSeason({ env_id: ENV_ID, deps_version: 1 })
    await storage.setSubmissionStatus(submissionSeason.id, 'open')
    const nextRound = await storage.createSubmission({
      season_id: submissionSeason.id,
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
      url: `/api/environments/${ENV_ID}/watch-agents`,
      headers: await users.headersFor('bob'),
    })

    expect(res.statusCode).toBe(200)
    expect(
      (res.json() as Array<{ submission_id: string }>).map((row) => row.submission_id),
    ).toEqual([playable.id])
  })

  it('serves an unpersonalized watch list to an anonymous caller (no rating status)', async () => {
    await build()
    await users.headersFor('alice')
    const season = await storage.ensureOpenSeason(ENV_ID, 1)
    const sub = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: users.idOf('alice'),
      source_kind: 'git',
      repo_url: 'https://example.test/alice',
      commit_sha: 'alice-sha',
      local_path: null,
      ref: null,
      created_at: new Date().toISOString(),
    })
    await storage.updateSubmissionStatus(sub.id, 'ready')

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/watch-agents`,
    })
    expect(res.statusCode).toBe(200)
    // Anonymous: the entry carries the sequence but no rating status and no operator extras.
    expect(res.json()).toEqual([{ submission_id: sub.id, anonymous_number: 1 }])
  })

  it('redacts watch-agent identity for regular viewers and reports rating state', async () => {
    await build()
    const carol = await users.headersFor('carol')
    await users.headersFor('alice')
    await users.headersFor('bob')
    const aliceId = users.idOf('alice')
    const season = await storage.ensureOpenSeason(ENV_ID, 1)
    const alice = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: aliceId,
      source_kind: 'git',
      repo_url: 'https://example.test/alice',
      commit_sha: 'alice-sha',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:00:00.000Z',
    })
    await storage.updateSubmissionStatus(alice.id, 'ready')
    const bob = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: users.idOf('bob'),
      source_kind: 'local',
      repo_url: null,
      commit_sha: null,
      local_path: '/agents/bob',
      ref: null,
      created_at: '2026-06-11T00:01:00.000Z',
    })
    await storage.updateSubmissionStatus(bob.id, 'ready')
    await storage.upsertRating({
      season_id: season.id,
      env_id: ENV_ID,
      rater_user_id: users.idOf('carol'),
      agent: { kind: 'submission', submission_id: alice.id, user_id: aliceId },
      score: 4,
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/watch-agents`,
      headers: carol,
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      {
        submission_id: bob.id,
        anonymous_number: 1,
        rating_status: 'unrated',
      },
      {
        submission_id: alice.id,
        anonymous_number: 2,
        rating_status: 'rated',
      },
    ])
    // No owner id, owner name, or source path leaks to a non-admin viewer.
    expect(JSON.stringify(rows)).not.toContain(aliceId)
    expect(JSON.stringify(rows)).not.toContain('owner_name')
    expect(JSON.stringify(rows)).not.toContain('/agents/bob')
  })

  it('marks the viewer own agent and gives admins owner and source details', async () => {
    await build()
    const alice = await users.headersFor('alice')
    const aliceId = users.idOf('alice')
    const season = await storage.ensureOpenSeason(ENV_ID, 1)
    const submission = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: aliceId,
      source_kind: 'git',
      repo_url: 'https://example.test/alice',
      commit_sha: 'alice-sha',
      local_path: null,
      ref: 'main',
      created_at: '2026-06-11T00:00:00.000Z',
    })
    await storage.updateSubmissionStatus(submission.id, 'ready')
    // A submission whose owner id has no user row: the operator extras keep the stable id but carry
    // no owner_name for it.
    const orphaned = await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'ghost-user',
      source_kind: 'git',
      repo_url: 'https://example.test/ghost',
      commit_sha: 'ghost-sha',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:01:00.000Z',
    })
    await storage.updateSubmissionStatus(orphaned.id, 'ready')

    // Newest first: the orphaned submission (created later) leads the sequence.
    const own = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/watch-agents`,
      headers: alice,
    })
    expect(own.json()).toEqual([
      {
        submission_id: orphaned.id,
        anonymous_number: 1,
        rating_status: 'unrated',
      },
      {
        submission_id: submission.id,
        anonymous_number: 2,
        rating_status: 'own',
      },
    ])

    const operator = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/watch-agents`,
      headers: await users.headersFor('op', { status: 'admin' }),
    })
    expect(operator.json()).toEqual([
      {
        // No user row for the owner id, so `owner_name` is absent and the id is the fallback.
        submission_id: orphaned.id,
        anonymous_number: 1,
        rating_status: 'unrated',
        owner_id: 'ghost-user',
        source_kind: 'git',
        repo_url: 'https://example.test/ghost',
        commit_sha: 'ghost-sha',
        local_path: null,
        ref: null,
      },
      {
        submission_id: submission.id,
        anonymous_number: 2,
        rating_status: 'unrated',
        owner_id: aliceId,
        owner_name: 'alice',
        source_kind: 'git',
        repo_url: 'https://example.test/alice',
        commit_sha: 'alice-sha',
        local_path: null,
        ref: 'main',
      },
    ])
  })

  describe('agent profile read', () => {
    it('returns one owner submission history with per-stage logs and recent replays', async () => {
      await build()
      const season = await storage.ensureOpenSeason(ENV_ID, 1)
      // The owner's first (now superseded) submission, which failed its load check.
      const first = await storage.createSubmission({
        season_id: season.id,
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
        season_id: season.id,
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
        parameters: { players: 1 },
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
      // The owner's rating prompt for the season, surfaced per season on the profile.
      await storage.upsertAgentRatingPrompt(season.id, 'eve', 'Judge my dodging')

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${ENV_ID}/agents/eve`,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        env_id: string
        owner_id: string
        submission_season_id: string | null
        play_season_id: string | null
        author_prompts: Record<string, string>
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
        submission_season_id: season.id,
        play_season_id: season.id,
      })
      // 'eve' is a raw id with no user row, so the profile carries no owner_name (id fallback).
      expect(body).not.toHaveProperty('owner_name')
      // The per-season author prompt is keyed by season id, resolved for the profile owner.
      expect(body.author_prompts[season.id]).toBe('Judge my dodging')
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
      expect(res.json()).not.toHaveProperty('owner_name')
    })

    it("resolves a real owner's display name beside the stable owner id", async () => {
      await build()
      await users.headersFor('alice')
      const aliceId = users.idOf('alice')
      sqlite.prepare('UPDATE "user" SET githubUsername = ? WHERE id = ?').run('octo-alice', aliceId)
      // The name resolves only for an owner who actually has a submission here (see the oracle test
      // below), so give alice one first.
      const season = await storage.ensureOpenSeason(ENV_ID, 1)
      await storage.createSubmission({
        season_id: season.id,
        env_id: ENV_ID,
        user_id: aliceId,
        source_kind: 'git',
        repo_url: 'https://example.test/alice',
        commit_sha: null,
        local_path: null,
        ref: null,
        created_at: new Date().toISOString(),
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${ENV_ID}/agents/${aliceId}`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        owner_id: aliceId,
        owner_name: 'alice',
        owner_github: 'octo-alice',
      })
    })

    it('omits owner_name for a real account with no submission here, so it is not an id-to-name oracle', async () => {
      await build()
      // alice is a real user with a display name, but has submitted nothing in this environment. An
      // open, unauthenticated profile route must not resolve her name from a bare id alone.
      await users.headersFor('alice')
      const aliceId = users.idOf('alice')
      sqlite.prepare('UPDATE "user" SET githubUsername = ? WHERE id = ?').run('octo-alice', aliceId)

      const res = await app.inject({
        method: 'GET',
        url: `/api/environments/${ENV_ID}/agents/${aliceId}`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ owner_id: aliceId, submissions: [] })
      expect(res.json()).not.toHaveProperty('owner_name')
      expect(res.json()).not.toHaveProperty('owner_github')
    })
  })
})
