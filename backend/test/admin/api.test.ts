/**
 * The operator-gated admin HTTP API (Stage 6.3), Docker-free with a stub runner and `:memory:`
 * storage. These prove the gating choke point, the declare/configure/lifecycle/trigger/cancel/status
 * contract, and the live log-stream relay without touching Docker — the runner is a recording stub.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TEMPLATE_REPO_URL_MAX } from '@game-sandbox/schema/seasons'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { DEPS_VERSION } from '../../src/build/deps-version.js'
import { decodeResolvedOfficialLlmPolicy } from '../../src/llm/config.js'
import { Retention } from '../../src/recordings/retention.js'
import { RecordingsStore } from '../../src/recordings/store.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import type {
  AgentRef,
  ScheduledGameInput,
  SeasonRun,
  Storage,
  Submission,
} from '../../src/storage/index.js'
import type { MatchConfig, SeasonConfig } from '../../src/storage/season-config.js'
import { SubmissionSnapshotStore } from '../../src/submission/snapshot-store.js'
import type { TestUsers } from '../support/auth.js'
import { FakeDriver } from '../support/fake-driver.js'
import {
  createRunOrFail,
  makeConfig,
  makeEnvironments,
  makeSubmissionDeps,
  openTestStack,
} from '../support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from '../support/llm-options.js'
import { StubWorkflowRunner } from '../support/stub-runner.js'

const ENV_ID = 'flappy_bird'
const RESTRICTED_ENV_ID = 'restricted'
/** Cookie headers for an admin session and a non-admin (normal) session, minted per test in `build`. */
let OPERATOR: Record<string, string>
let STRANGER: Record<string, string>

// The dependency versions the test app knows about, and the first version just past them. Includes
// DEPS_VERSION so a default declare (which pins the current version) stays accepted after a release
// bump; 1 and 2 keep the multi-version path exercised. Deriving the unsupported version instead of
// hardcoding it keeps the "not supported" tests correct once DEPS_VERSION reaches 3 or beyond.
const DEFAULT_KNOWN_DEPS_VERSIONS: ReadonlySet<number> = new Set([1, 2, DEPS_VERSION])
const UNSUPPORTED_DEPS_VERSION = Math.max(...DEFAULT_KNOWN_DEPS_VERSIONS) + 1

/** A valid single-submission-seat Flappy Bird config; `deps_version` overridable for the change path. */
function flappyConfig(overrides: Partial<SeasonConfig> = {}): SeasonConfig {
  return {
    deps_version: 1,
    matches: [{ seats: ['submission'], seeds: [1, 2], games: 2 }],
    ...overrides,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('admin API', () => {
  let app: FastifyInstance
  let storage: Storage
  let users: TestUsers
  let orchestrator: Orchestrator
  let runner: StubWorkflowRunner
  let snapshots: SubmissionSnapshotStore
  let dir: string

  async function build(
    knownDepsVersions: ReadonlySet<number> = DEFAULT_KNOWN_DEPS_VERSIONS,
  ): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'gs-admin-'))
    const stack = await openTestStack()
    storage = stack.storage
    users = stack.users
    // An admin session gates the whole prefix; a normal (non-admin) session is the rejected stranger.
    OPERATOR = await users.headersFor('operator', { status: 'admin' })
    STRANGER = await users.headersFor('carol', { status: 'normal' })
    const config = makeConfig({ recordingsDir: dir })
    const environments = makeEnvironments()
    orchestrator = new Orchestrator({ driver: new FakeDriver(), storage, environments, config })
    const recordings = new RecordingsStore(dir)
    runner = new StubWorkflowRunner(storage)
    // A snapshot store the tests can pre-seed, so the download routes have real archives to serve.
    snapshots = new SubmissionSnapshotStore(join(dir, 'submissions'))
    app = await buildApp({
      orchestrator,
      environments,
      recordings,
      retention: new Retention(storage, recordings, config),
      auth: stack.auth,
      userDirectory: stack.userDirectory,
      ...makeSubmissionDeps(storage, config, { snapshots }),
      llm: config.llm,
      templateRepoUrl: config.templateRepoUrl,
      knownDepsVersions,
      workflowRunner: runner,
    })
    await app.ready()
  }

  async function createRun(
    seasonId: string,
    requestedBy: string,
    submissions: AgentRef[],
    games: ScheduledGameInput[],
  ): Promise<SeasonRun> {
    for (const submission of submissions) {
      if (submission.kind === 'submission') {
        await storage.updateSubmissionStatus(submission.submission_id, 'ready')
      }
    }
    return createRunOrFail(storage, seasonId, requestedBy, () => ({
      parametersSnapshot: { players: 1 },
      scheduledGames: games,
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
  }

  /** Insert a submission row directly, optionally writing it a downloadable snapshot. */
  async function seedSubmission(
    seasonId: string,
    userId: string,
    opts: { withSnapshot?: boolean } = {},
  ): Promise<Submission> {
    const submission = await storage.createSubmission({
      season_id: seasonId,
      env_id: ENV_ID,
      user_id: userId,
      source_kind: 'git',
      repo_url: 'https://example.test/repo',
      commit_sha: 'c0ffee1234',
      local_path: null,
      ref: null,
      created_at: new Date().toISOString(),
    })
    if (opts.withSnapshot !== false) {
      const tree = mkdtempSync(join(tmpdir(), 'gs-admin-src-'))
      writeFileSync(join(tree, 'agent.py'), 'class Agent:\n    pass\n')
      await snapshots.write(submission.id, tree)
      rmSync(tree, { recursive: true, force: true })
    }
    return submission
  }

  /** Declare a season over HTTP and return its id. */
  async function declare(envId = ENV_ID): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/environments/${envId}/seasons`,
      headers: OPERATOR,
      payload: {},
    })
    expect(res.statusCode).toBe(201)
    return (res.json() as { id: string }).id
  }

  beforeEach(() => build())

  afterEach(async () => {
    await orchestrator.shutdown()
    await app.close()
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('operator gating', () => {
    it('rejects every admin route for a non-operator with 403 not_operator', async () => {
      const id = await declare()
      const routes: Array<[string, string]> = [
        ['POST', `/api/admin/environments/${ENV_ID}/seasons`],
        ['DELETE', `/api/admin/seasons/${id}`],
        ['PUT', `/api/admin/seasons/${id}/config`],
        ['PUT', `/api/admin/seasons/${id}/description`],
        ['PUT', `/api/admin/seasons/${id}/template-repository`],
        ['PUT', `/api/admin/seasons/${id}/rating-prompt`],
        ['PUT', `/api/admin/seasons/${id}/label`],
        ['POST', `/api/admin/seasons/${id}/submissions/open`],
        ['POST', `/api/admin/seasons/${id}/submissions/close`],
        ['POST', `/api/admin/seasons/${id}/play/open`],
        ['POST', `/api/admin/seasons/${id}/play/close`],
        ['POST', `/api/admin/seasons/${id}/release`],
        ['POST', `/api/admin/seasons/${id}/unrelease`],
        ['POST', `/api/admin/seasons/${id}/runs`],
        ['POST', `/api/admin/seasons/${id}/runs/whatever/cancel`],
        ['GET', `/api/admin/seasons/${id}`],
        ['GET', `/api/admin/seasons/${id}/runs`],
        ['GET', `/api/admin/seasons/${id}/runs/whatever`],
        ['GET', `/api/admin/seasons/${id}/submissions`],
        ['GET', `/api/admin/seasons/${id}/submissions/download`],
        ['GET', `/api/admin/seasons/${id}/ratings`],
        ['GET', `/api/admin/submissions/whatever/download`],
      ]
      for (const [method, url] of routes) {
        const res = await app.inject({
          method: method as 'GET',
          url,
          headers: STRANGER,
          payload: {},
        })
        expect(res.statusCode, `${method} ${url}`).toBe(403)
        expect(res.json()).toMatchObject({ code: 'not_operator' })
      }
    })

    it('rejects an anonymous request with 401 auth_required', async () => {
      const id = await declare()
      const res = await app.inject({ method: 'GET', url: `/api/admin/seasons/${id}` })
      expect(res.statusCode).toBe(401)
      expect(res.json()).toMatchObject({ code: 'auth_required' })
    })

    it('rejects the log-stream WebSocket upgrade for a non-operator and an anonymous client', async () => {
      const id = await declare()
      // The prefix `requireAdmin` hook runs on the upgrade before any handler, so the gate holds even
      // for a bogus run id; a rejected upgrade surfaces as a failed connection rather than a socket.
      const url = `/api/admin/seasons/${id}/runs/whatever/logs/ws`
      await expect(app.injectWS(url, { headers: STRANGER })).rejects.toThrow()
      await expect(app.injectWS(url)).rejects.toThrow()
    })

    it('proceeds for an admin session', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('season deletion', () => {
    it('removes an empty private season and returns 404 after it is gone', async () => {
      const id = await declare()

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/admin/seasons/${id}`,
        headers: OPERATOR,
      })
      expect(removed.statusCode).toBe(204)

      const missing = await app.inject({
        method: 'DELETE',
        url: `/api/admin/seasons/${id}`,
        headers: OPERATOR,
      })
      expect(missing.statusCode).toBe(404)
      expect(missing.json()).toEqual({ error: 'no such season' })
    })

    it('reports stable conflicts for public seasons and seasons with activity', async () => {
      const open = await declare()
      await storage.setSubmissionStatus(open, 'open')
      const publicSeason = await app.inject({
        method: 'DELETE',
        url: `/api/admin/seasons/${open}`,
        headers: OPERATOR,
      })
      expect(publicSeason.statusCode).toBe(409)
      expect(publicSeason.json()).toEqual({
        error: 'season_not_deletable',
        code: 'season_not_deletable',
      })

      const active = await declare()
      await seedSubmission(active, users.idOf('carol'))
      const populatedSeason = await app.inject({
        method: 'DELETE',
        url: `/api/admin/seasons/${active}`,
        headers: OPERATOR,
      })
      expect(populatedSeason.statusCode).toBe(409)
      expect(populatedSeason.json()).toEqual({
        error: 'season_not_empty',
        code: 'season_not_empty',
      })

      const prompted = await declare()
      await storage.setSeasonRatingPrompt(prompted, 'Evaluate every agent fairly.')
      const promptedSeason = await app.inject({
        method: 'DELETE',
        url: `/api/admin/seasons/${prompted}`,
        headers: OPERATOR,
      })
      expect(promptedSeason.statusCode).toBe(409)
      expect(promptedSeason.json()).toEqual({
        error: 'season_not_empty',
        code: 'season_not_empty',
      })

      // A Season description is display-only metadata, so it never blocks deletion on its own.
      const described = await declare()
      await storage.setSeasonDescription(described, 'A seeded Season description.')
      const describedSeason = await app.inject({
        method: 'DELETE',
        url: `/api/admin/seasons/${described}`,
        headers: OPERATOR,
      })
      expect(describedSeason.statusCode).toBe(204)
    })
  })

  describe('submission downloads', () => {
    it("lists a season's active submissions with their snapshot state and owner names", async () => {
      const seasonId = await declare()
      // One submission owned by a real user (carol is minted in build()), one by a rowless raw id.
      const carolId = users.idOf('carol')
      await seedSubmission(seasonId, carolId, { withSnapshot: true })
      await seedSubmission(seasonId, 'bob', { withSnapshot: false })

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${seasonId}/submissions`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      const rows = res.json() as Array<{
        user_id: string
        user_name?: string
        has_snapshot: boolean
      }>
      expect(rows).toHaveLength(2)
      // The display name rides beside the stable id; a rowless owner id carries no user_name.
      expect(rows.find((r) => r.user_id === carolId)).toMatchObject({
        user_name: 'carol',
        has_snapshot: true,
      })
      expect(rows.find((r) => r.user_id === 'bob')?.has_snapshot).toBe(false)
      expect(rows.find((r) => r.user_id === 'bob')).not.toHaveProperty('user_name')
    })

    it("streams one submission's snapshot as a gzip attachment", async () => {
      const seasonId = await declare()
      const submission = await seedSubmission(seasonId, 'alice', { withSnapshot: true })

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/submissions/${submission.id}/download`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('application/gzip')
      expect(res.headers['content-disposition']).toContain('attachment')
      expect(res.headers['content-disposition']).toContain('.tar.gz')
      // gzip magic bytes confirm a real archive came back.
      expect(res.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    })

    it('404s no_snapshot for a submission that has none, and 404s an unknown id', async () => {
      const seasonId = await declare()
      const submission = await seedSubmission(seasonId, 'bob', { withSnapshot: false })

      const noSnapshot = await app.inject({
        method: 'GET',
        url: `/api/admin/submissions/${submission.id}/download`,
        headers: OPERATOR,
      })
      expect(noSnapshot.statusCode).toBe(404)
      expect(noSnapshot.json()).toMatchObject({ code: 'no_snapshot' })

      const unknown = await app.inject({
        method: 'GET',
        url: '/api/admin/submissions/does-not-exist/download',
        headers: OPERATOR,
      })
      expect(unknown.statusCode).toBe(404)
    })

    it('archives the whole season, skipping submissions without a snapshot rather than 500ing', async () => {
      const seasonId = await declare()
      await seedSubmission(seasonId, 'alice', { withSnapshot: true })
      await seedSubmission(seasonId, 'bob', { withSnapshot: false })

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${seasonId}/submissions/download`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('application/gzip')
      expect(res.headers['content-disposition']).toContain(`season-${seasonId.slice(0, 8)}.tar.gz`)
      expect(res.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    })

    it('hides stale snapshots after static failure but preserves later-stage failure snapshots', async () => {
      const seasonId = await declare()
      const staticFailed = await seedSubmission(seasonId, 'static-owner', { withSnapshot: true })
      const buildFailed = await seedSubmission(seasonId, 'build-owner', { withSnapshot: true })
      const loadFailed = await seedSubmission(seasonId, 'load-owner', { withSnapshot: true })
      await storage.updateSubmissionStatus(
        staticFailed.id,
        'static_failed',
        'snapshot storage failed',
      )
      await storage.updateSubmissionStatus(buildFailed.id, 'build_failed', 'image build failed')
      await storage.updateSubmissionStatus(loadFailed.id, 'load_failed', 'agent load failed')

      const listing = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${seasonId}/submissions`,
        headers: OPERATOR,
      })
      expect(listing.statusCode).toBe(200)
      const rows = listing.json() as Array<{ id: string; has_snapshot: boolean }>
      expect(rows.find((row) => row.id === staticFailed.id)?.has_snapshot).toBe(false)
      expect(rows.find((row) => row.id === buildFailed.id)?.has_snapshot).toBe(true)
      expect(rows.find((row) => row.id === loadFailed.id)?.has_snapshot).toBe(true)

      const staleDownload = await app.inject({
        method: 'GET',
        url: `/api/admin/submissions/${staticFailed.id}/download`,
        headers: OPERATOR,
      })
      expect(staleDownload.statusCode).toBe(404)
      expect(staleDownload.json()).toMatchObject({ code: 'no_snapshot' })

      for (const submission of [buildFailed, loadFailed]) {
        const validDownload = await app.inject({
          method: 'GET',
          url: `/api/admin/submissions/${submission.id}/download`,
          headers: OPERATOR,
        })
        expect(validDownload.statusCode).toBe(200)
      }

      const materialized: string[] = []
      const materializeInto = snapshots.materializeInto.bind(snapshots)
      snapshots.materializeInto = (id, destDir) => {
        materialized.push(id)
        return materializeInto(id, destDir)
      }
      const seasonArchive = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${seasonId}/submissions/download`,
        headers: OPERATOR,
      })
      expect(seasonArchive.statusCode).toBe(200)
      expect(materialized).toHaveLength(2)
      expect(materialized).toEqual(expect.arrayContaining([buildFailed.id, loadFailed.id]))
      expect(materialized).not.toContain(staticFailed.id)
    })
  })

  describe('season ratings', () => {
    it('reports ratings grouped by rated agent and by rater, with names resolved', async () => {
      const seasonId = await declare()
      // carol is minted in build() already; resolve her id and her agent's row.
      const carolId = users.idOf('carol')
      const carol = await seedSubmission(seasonId, carolId, { withSnapshot: false })
      const bob = await seedSubmission(seasonId, 'bob', { withSnapshot: false })
      // dave submits too but rates nobody, so a minted zero-count participant resolves by name below.
      await users.headersFor('dave')
      const daveId = users.idOf('dave')
      await seedSubmission(seasonId, daveId, { withSnapshot: false })
      const carolAgent = agentRef(carol)
      const bobAgent = agentRef(bob)
      // Carol rates bob's agent and the Naive baseline; sam and tam (unminted ids, so no user rows)
      // rate carol's agent. The own-agent rule means carol cannot rate her own submission, so a
      // minted rater name and an absent one are each proven against a different agent's row.
      await storage.upsertRating({
        season_id: seasonId,
        env_id: ENV_ID,
        rater_user_id: carolId,
        agent: bobAgent,
        score: 3,
        feedback: 'Meh',
      })
      await storage.upsertRating({
        season_id: seasonId,
        env_id: ENV_ID,
        rater_user_id: carolId,
        agent: { kind: 'builtin', name: 'naive' },
        score: 2,
        feedback: 'Bland',
      })
      await storage.upsertRating({
        season_id: seasonId,
        env_id: ENV_ID,
        rater_user_id: 'sam',
        agent: carolAgent,
        score: 5,
        feedback: 'Great',
      })
      await storage.upsertRating({
        season_id: seasonId,
        env_id: ENV_ID,
        rater_user_id: 'tam',
        agent: carolAgent,
        score: 4,
        feedback: 'Nice',
      })

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${seasonId}/ratings`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        by_agent: Array<{
          agent: Record<string, unknown>
          mean: number
          count: number
          ratings: Array<{
            score: number
            feedback: string
            rater_user_id: string
            rater_name?: string
          }>
        }>
        by_rater: Array<{
          rater_user_id: string
          rater_name?: string
          count: number
          ratings: Array<{ agent: Record<string, unknown> }>
        }>
      }

      // Every rated agent appears, ordered by mean descending: carol's agent (4.5), bob's (3), Naive.
      expect(body.by_agent).toHaveLength(3)
      expect(body.by_agent.map((row) => row.mean)).toEqual([4.5, 3, 2])

      const carolRow = body.by_agent.find((row) => row.agent.submission_id === carol.id)
      expect(carolRow?.agent).toEqual({ ...carolAgent, user_name: 'carol' })
      expect(carolRow?.count).toBe(2)
      expect(carolRow?.ratings).toHaveLength(2)
      const samRating = carolRow?.ratings.find((r) => r.rater_user_id === 'sam')
      expect(samRating).toMatchObject({ score: 5, feedback: 'Great', rater_user_id: 'sam' })
      const tamRating = carolRow?.ratings.find((r) => r.rater_user_id === 'tam')
      expect(tamRating).toMatchObject({ score: 4, feedback: 'Nice', rater_user_id: 'tam' })
      // sam and tam have no user rows, so the rater name is omitted, not blank.
      expect(samRating).not.toHaveProperty('rater_name')
      expect(tamRating).not.toHaveProperty('rater_name')

      const bobRow = body.by_agent.find((row) => row.agent.submission_id === bob.id)
      expect(bobRow?.agent).toEqual(bobAgent)
      expect(bobRow?.agent).not.toHaveProperty('user_name')
      expect(bobRow?.count).toBe(1)
      expect(bobRow?.ratings[0]).toMatchObject({
        score: 3,
        feedback: 'Meh',
        rater_user_id: carolId,
        rater_name: 'carol',
      })

      const naiveRow = body.by_agent.find((row) => row.agent.kind === 'builtin')
      expect(naiveRow?.agent).toEqual({ kind: 'builtin', name: 'naive', label: 'Naive agent' })
      expect(naiveRow?.mean).toBe(2)

      // by_rater covers every participant with a submission plus every rater, count ascending with
      // zero-rating participants first: bob and dave submitted but never rated anyone. A minted
      // zero-count participant resolves by name, an unminted one falls back to the stable id.
      expect(body.by_rater).toHaveLength(5)
      expect(body.by_rater.map((row) => row.count).sort()).toEqual([0, 0, 1, 1, 2])
      expect(body.by_rater[0]?.count).toBe(0)
      const zeroRows = body.by_rater.filter((row) => row.count === 0)
      expect(zeroRows).toHaveLength(2)
      const bobZero = zeroRows.find((row) => row.rater_user_id === 'bob')
      expect(bobZero).toMatchObject({ rater_user_id: 'bob', count: 0, ratings: [] })
      expect(bobZero).not.toHaveProperty('rater_name')
      const daveRater = body.by_rater.find((row) => row.rater_user_id === daveId)
      expect(daveRater).toMatchObject({ rater_name: 'dave', count: 0, ratings: [] })
      const carolRater = body.by_rater.find((row) => row.rater_user_id === carolId)
      expect(carolRater?.rater_name).toBe('carol')
      expect(carolRater?.count).toBe(2)
      expect(carolRater?.ratings.find((r) => r.agent.submission_id === bob.id)).toMatchObject({
        agent: bobAgent,
      })
      for (const rater of ['sam', 'tam']) {
        const row = body.by_rater.find((r) => r.rater_user_id === rater)
        expect(row?.count).toBe(1)
        expect(row).not.toHaveProperty('rater_name')
      }

      // The single operator-gate covers this read like every other admin route.
      const stranger = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${seasonId}/ratings`,
        headers: STRANGER,
      })
      expect(stranger.statusCode).toBe(403)
      expect(stranger.json()).toMatchObject({ code: 'not_operator' })

      const anon = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${seasonId}/ratings`,
      })
      expect(anon.statusCode).toBe(401)
      expect(anon.json()).toMatchObject({ code: 'auth_required' })
    })
  })

  describe('declare', () => {
    it('creates an unreleased, submission-closed, play-closed season with the current deps_version', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/environments/${ENV_ID}/seasons`,
        headers: OPERATOR,
        payload: { label: 'Week 1' },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json() as {
        id: string
        submission_status: string
        play_status: string
        release_status: string
        label: string
        config: SeasonConfig
      }
      expect(body).toMatchObject({
        submission_status: 'closed',
        play_status: 'closed',
        release_status: 'unreleased',
        label: 'Week 1',
      })
      expect(body.config).toEqual({ deps_version: DEPS_VERSION, matches: [] })
    })

    it('404s declaring against an unknown environment', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/environments/nope/seasons',
        headers: OPERATOR,
        payload: {},
      })
      expect(res.statusCode).toBe(404)
    })

    it('400s an invalid declaration body before storage sees it', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['non-positive deps_version', { deps_version: 0 }],
        ['non-integer deps_version', { deps_version: 1.5 }],
        ['non-string label', { label: 123 }],
        ['unknown key', { label: 'Week 1', extra: true }],
      ]
      for (const [name, payload] of cases) {
        const res = await app.inject({
          method: 'POST',
          url: `/api/admin/environments/${ENV_ID}/seasons`,
          headers: OPERATOR,
          payload,
        })
        expect(res.statusCode, name).toBe(400)
        expect(res.json()).toMatchObject({ code: 'invalid_season_declaration' })
        expect((res.json() as { reason: string }).reason).toBeTruthy()
      }
    })

    it('400s a dependency version with no deployment image definition', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/environments/${ENV_ID}/seasons`,
        headers: OPERATOR,
        payload: { deps_version: UNSUPPORTED_DEPS_VERSION },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid_season_declaration',
        reason: expect.stringContaining(
          `deps_version ${UNSUPPORTED_DEPS_VERSION} is not supported`,
        ),
      })
    })
  })

  describe('configure', () => {
    it('round-trips a valid SeasonConfig', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: flappyConfig(),
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { config: SeasonConfig }).config).toEqual(flappyConfig())
    })

    it('round-trips a season config with an empty seed list', async () => {
      const id = await declare()
      const config = {
        deps_version: 1,
        matches: [{ seats: ['submission'], seeds: [], games: 1 }],
      }
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: config,
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { config: SeasonConfig }).config).toEqual(config)
    })

    it('400s an invalid config with a specific reason', async () => {
      const id = await declare()
      const cases: Array<[string, Record<string, unknown>]> = [
        ['zero seats', { deps_version: 1, matches: [{ seats: [], seeds: [1], games: 1 }] }],
        [
          'non-positive games',
          { deps_version: 1, matches: [{ seats: ['submission'], seeds: [1], games: 0 }] },
        ],
        ['unknown key', { deps_version: 1, matches: [], bogus: true }],
      ]
      for (const [name, payload] of cases) {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/admin/seasons/${id}/config`,
          headers: OPERATOR,
          payload,
        })
        expect(res.statusCode, name).toBe(400)
        const body = res.json() as { code: string; reason: string }
        expect(body.code).toBe('invalid_config')
        expect(body.reason).toBeTruthy()
      }
    })

    it('rejects a model alias unavailable on this deployment', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: flappyConfig({ overrides: { llm: { enabled: true, models: ['small'] } } }),
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid_config',
        reason: expect.stringContaining('small'),
      })
    })

    it('400s a match whose seat count mismatches the resolved layout (max 1 for Flappy)', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: {
          deps_version: 1,
          matches: [{ seats: ['submission', 'builtin:naive'], seeds: [1], games: 1 }],
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid_config' })
      expect((res.json() as { reason: string }).reason).toMatch(
        /must equal the resolved layout count/,
      )
    })

    it('accepts declared named builtins and rejects malformed, unknown, restricted, and wrong-width rows', async () => {
      const valid = {
        deps_version: 1,
        matches: [{ seats: ['builtin:scripted_hero', 'submission'], seeds: [1], games: 1 }],
      }
      const accepted = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${await declare(RESTRICTED_ENV_ID)}/config`,
        headers: OPERATOR,
        payload: valid,
      })
      expect(accepted.statusCode).toBe(200)

      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        [
          'malformed builtin name',
          {
            ...valid,
            matches: [{ ...valid.matches[0], seats: ['builtin:Scripted', 'submission'] }],
          },
          /builtin:<snake_case>/,
        ],
        [
          'undeclared builtin',
          {
            ...valid,
            matches: [{ ...valid.matches[0], seats: ['builtin:unknown', 'submission'] }],
          },
          /not declared/,
        ],
        [
          'wrong builtin on restricted seat',
          { ...valid, matches: [{ ...valid.matches[0], seats: ['builtin:naive', 'submission'] }] },
          /must use builtin:scripted_hero/,
        ],
        [
          'wrong row width',
          { ...valid, matches: [{ ...valid.matches[0], seats: ['builtin:scripted_hero'] }] },
          /resolved layout count/,
        ],
      ]
      for (const [name, payload, reason] of cases) {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/admin/seasons/${await declare(RESTRICTED_ENV_ID)}/config`,
          headers: OPERATOR,
          payload,
        })
        expect(res.statusCode, name).toBe(400)
        expect(res.json()).toMatchObject({
          code: 'invalid_config',
          reason: expect.stringMatching(reason),
        })
      }
    })

    it('400s a config whose dependency version has no deployment image definition', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: flappyConfig({ deps_version: UNSUPPORTED_DEPS_VERSION }),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid_config',
        reason: expect.stringContaining(
          `deps_version ${UNSUPPORTED_DEPS_VERSION} is not supported`,
        ),
      })
    })

    it('refuses a config edit against existing runs without force, and succeeds with force', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      // A run plus a result and a placement, all of which a forced edit must clear.
      const ready = await makeReadySubmission(storage, id)
      const run = await createRun(
        id,
        'dev-user',
        [agentRef(ready)],
        [{ match_index: 0, game_index: 0, seed: 1, seats: [agentRef(ready)], seat_plan: 'solo' }],
      )
      const games = await storage.listRunGames(run.id)
      await storage.recordGameResult({
        game_id: first(games).id,
        seat_index: 0,
        agent: agentRef(ready),
        episode_score: 5,
        agent_compute_ms_total: 10,
        acted_tick_count: 2,
        failed: false,
      })
      await storage.replaceAutomatedPlacements(id, ENV_ID, run.id, [
        {
          rank: 1,
          agent: agentRef(ready),
          mean_score: 5,
          mean_agent_compute_ms: 5,
          failure_count: 0,
          recording_id: null,
        },
      ])

      const refused = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: flappyConfig({ matches: [{ seats: ['submission'], seeds: [9], games: 1 }] }),
      })
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'season_has_runs' })
      expect(runner.cancelled).toEqual([])

      const forced = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config?force=true`,
        headers: OPERATOR,
        payload: flappyConfig({ matches: [{ seats: ['submission'], seeds: [9], games: 1 }] }),
      })
      expect(forced.statusCode).toBe(200)
      expect(runner.cancelled).toEqual([run.id])
      expect(await storage.getLatestRun(id)).toBeUndefined()
      expect(await storage.listGameResultsByRun(run.id)).toEqual([])
      expect(await storage.listPlacementsByAgent(agentRef(ready))).toEqual([])
    })

    it('refuses a deps_version change against existing submissions without force, deletes them with force', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      await makeReadySubmission(storage, id)

      const refused = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: flappyConfig({ deps_version: 2 }),
      })
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'season_has_submissions' })

      const forced = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config?force=true`,
        headers: OPERATOR,
        payload: flappyConfig({ deps_version: 2 }),
      })
      expect(forced.statusCode).toBe(200)
      expect(await storage.listActiveSubmissionsBySeason(id)).toEqual([])
    })
  })

  describe('season description', () => {
    it('normalizes, replaces, and clears the description after a run and release', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )
      await storage.setReleaseStatus(id, 'released')

      const saved = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/description`,
        headers: OPERATOR,
        payload: { markdown: '  **Start here**\r\nThen submit your agent.  ' },
      })
      expect(saved.statusCode).toBe(200)
      expect((saved.json() as { description_markdown: string }).description_markdown).toBe(
        '**Start here**\nThen submit your agent.',
      )

      const replaced = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/description`,
        headers: OPERATOR,
        payload: { markdown: 'x'.repeat(2_000) },
      })
      expect(replaced.statusCode).toBe(200)
      expect(
        (replaced.json() as { description_markdown: string }).description_markdown,
      ).toHaveLength(2_000)

      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/description`,
        headers: OPERATOR,
        payload: { markdown: ' \r\n\t ' },
      })
      expect(cleared.statusCode).toBe(200)
      expect(
        (cleared.json() as { description_markdown: string | null }).description_markdown,
      ).toBeNull()
    })

    it('returns typed validation errors and 404s an unknown Season', async () => {
      const id = await declare()
      const invalidBodies = [{}, { markdown: 123 }, { markdown: 'valid', extra: true }]
      for (const payload of invalidBodies) {
        const invalid = await app.inject({
          method: 'PUT',
          url: `/api/admin/seasons/${id}/description`,
          headers: OPERATOR,
          payload,
        })
        expect(invalid.statusCode).toBe(400)
        expect(invalid.json()).toMatchObject({ code: 'invalid_season_description' })
      }

      const multiple = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/description`,
        headers: OPERATOR,
        payload: { markdown: 'First paragraph.\n \t\nSecond paragraph.' },
      })
      expect(multiple.statusCode).toBe(400)
      expect(multiple.json()).toMatchObject({
        code: 'season_description_multiple_paragraphs',
      })

      const tooLong = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/description`,
        headers: OPERATOR,
        payload: { markdown: ` ${'x'.repeat(2_001)} ` },
      })
      expect(tooLong.statusCode).toBe(400)
      expect(tooLong.json()).toMatchObject({ code: 'season_description_too_long' })

      const missing = await app.inject({
        method: 'PUT',
        url: '/api/admin/seasons/does-not-exist/description',
        headers: OPERATOR,
        payload: { markdown: 'Welcome.' },
      })
      expect(missing.statusCode).toBe(404)
    })

    it.each([
      ['line separator', '\u2028'],
      ['paragraph separator', '\u2029'],
      ['vertical tab', '\v'],
      ['form feed', '\f'],
    ])('replaces a %s with a space before storing the description', async (_label, separator) => {
      const id = await declare()
      const saved = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/description`,
        headers: OPERATOR,
        payload: { markdown: `First${separator}second.` },
      })

      expect(saved.statusCode).toBe(200)
      expect((saved.json() as { description_markdown: string }).description_markdown).toBe(
        'First second.',
      )
      expect((await storage.getSeason(id))?.description_markdown).toBe('First second.')
    })
  })

  describe('template repository', () => {
    it('sets, replaces, and clears the URL after a run exists', async () => {
      const id = await declare()
      await seedSubmission(id, 'alice')
      await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )

      const saved = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/template-repository`,
        headers: OPERATOR,
        payload: { template_repo_url: ' https://example.test/template ' },
      })
      expect(saved.statusCode).toBe(200)
      expect((saved.json() as { template_repo_url: string }).template_repo_url).toBe(
        'https://example.test/template',
      )
      expect((await storage.getSeason(id))?.template_repo_url).toBe('https://example.test/template')

      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/template-repository`,
        headers: OPERATOR,
        payload: { template_repo_url: '   ' },
      })
      expect(cleared.statusCode).toBe(200)
      expect((cleared.json() as { template_repo_url: string | null }).template_repo_url).toBeNull()
    })

    it('rejects an invalid body and returns 404 for an unknown season', async () => {
      const id = await declare()
      for (const payload of [
        {},
        { template_repo_url: 123 },
        { template_repo_url: 'git@example.test:template.git' },
        { template_repo_url: 'ftp://example.test/template' },
        { template_repo_url: 'https://user:secret@example.test/template' },
        { template_repo_url: 'https://example.test/template?token=secret' },
        { template_repo_url: 'https://example.test/template#main' },
        { template_repo_url: 'https://example.test/template;echo' },
        { template_repo_url: 'https://example.test/%USERNAME%' },
        { template_repo_url: 'https://example.test/template name' },
        { template_repo_url: `https://example.test/${'a'.repeat(TEMPLATE_REPO_URL_MAX)}` },
        { template_repo_url: 'https://example.test', extra: true },
      ]) {
        const invalid = await app.inject({
          method: 'PUT',
          url: `/api/admin/seasons/${id}/template-repository`,
          headers: OPERATOR,
          payload,
        })
        expect(invalid.statusCode).toBe(400)
        expect(invalid.json()).toMatchObject({ code: 'invalid_template_repo_url' })
      }
      const missing = await app.inject({
        method: 'PUT',
        url: '/api/admin/seasons/does-not-exist/template-repository',
        headers: OPERATOR,
        payload: { template_repo_url: 'https://example.test/template' },
      })
      expect(missing.statusCode).toBe(404)
    })
  })

  describe('rating prompt', () => {
    it('sets the operator prompt even after a run exists (never gated by the config rules)', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/rating-prompt`,
        headers: OPERATOR,
        payload: { prompt: 'Rate creativity 1-5' },
      })
      expect(res.statusCode).toBe(200)
      expect((res.json() as { rating_prompt: string }).rating_prompt).toBe('Rate creativity 1-5')
      // Clearing it round-trips back to null.
      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/rating-prompt`,
        headers: OPERATOR,
        payload: { prompt: null },
      })
      expect((cleared.json() as { rating_prompt: string | null }).rating_prompt).toBeNull()
    })

    it('400s an invalid rating-prompt body through zod', async () => {
      const id = await declare()
      const invalidType = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/rating-prompt`,
        headers: OPERATOR,
        payload: { prompt: 123 },
      })
      expect(invalidType.statusCode).toBe(400)
      expect(invalidType.json()).toMatchObject({ code: 'invalid_rating_prompt' })

      const tooLong = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/rating-prompt`,
        headers: OPERATOR,
        payload: { prompt: 'x'.repeat(2_001) },
      })
      expect(tooLong.statusCode).toBe(400)
      expect(tooLong.json()).toMatchObject({ code: 'rating_prompt_too_long' })
    })
  })

  describe('rename', () => {
    it('renames a season and clears the label back to null on empty input', async () => {
      const id = await declare()
      const renamed = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/label`,
        headers: OPERATOR,
        payload: { label: '  Playground  ' },
      })
      expect(renamed.statusCode).toBe(200)
      // The label is trimmed on the way in.
      expect((renamed.json() as { label: string }).label).toBe('Playground')

      const cleared = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/label`,
        headers: OPERATOR,
        payload: { label: '   ' },
      })
      expect((cleared.json() as { label: string | null }).label).toBeNull()
    })

    it('404s renaming an unknown season and 400s an overlong label', async () => {
      const id = await declare()
      const missing = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/does-not-exist/label`,
        headers: OPERATOR,
        payload: { label: 'x' },
      })
      expect(missing.statusCode).toBe(404)

      const tooLong = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/label`,
        headers: OPERATOR,
        payload: { label: 'x'.repeat(101) },
      })
      expect(tooLong.statusCode).toBe(400)
      expect(tooLong.json()).toMatchObject({ code: 'season_label_too_long' })
    })
  })

  describe('lifecycle gates', () => {
    it('opens and closes the submission window under the one-open invariant', async () => {
      const a = await declare()
      const b = await declare()
      const open = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${a}/submissions/open`,
        headers: OPERATOR,
      })
      expect(open.statusCode).toBe(200)
      expect((open.json() as { submission_status: string }).submission_status).toBe('open')

      const conflict = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${b}/submissions/open`,
        headers: OPERATOR,
      })
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json()).toMatchObject({ code: 'open_season_exists' })

      await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${a}/submissions/close`,
        headers: OPERATOR,
      })
      const reopen = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${b}/submissions/open`,
        headers: OPERATOR,
      })
      expect(reopen.statusCode).toBe(200)
    })

    it('opens public play on an unreleased season under the one-play-open invariant', async () => {
      const a = await declare()
      const b = await declare()
      const open = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${a}/play/open`,
        headers: OPERATOR,
      })
      expect(open.statusCode).toBe(200)
      const body = open.json() as { play_status: string; release_status: string }
      expect(body.play_status).toBe('open')
      expect(body.release_status).toBe('unreleased')

      const conflict = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${b}/play/open`,
        headers: OPERATOR,
      })
      expect(conflict.statusCode).toBe(409)
      expect(conflict.json()).toMatchObject({ code: 'open_play_season_exists' })
    })

    it('releases and unreleases, stamping released_at once', async () => {
      const id = await declare()
      const released = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/release`,
        headers: OPERATOR,
      })
      const first = released.json() as { release_status: string; released_at: string }
      expect(first.release_status).toBe('released')
      expect(first.released_at).toBeTruthy()

      await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/unrelease`,
        headers: OPERATOR,
      })
      const rereleased = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/release`,
        headers: OPERATOR,
      })
      // The stamp is stable across an unrelease/re-release cycle.
      expect((rereleased.json() as { released_at: string }).released_at).toBe(first.released_at)
    })

    it('404s a gate flip against an unknown season', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/seasons/nope/release',
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('trigger and cancel', () => {
    it('snapshots the roster and schedule, persists before enqueue, and returns the run id without Docker', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      const ready = await makeReadySubmission(storage, id)

      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(201)
      const runId = (res.json() as { id: string }).id

      // The runner only recorded the enqueue — nothing ran inline.
      expect(runner.enqueued).toEqual([runId])
      const run = defined(await storage.getRun(runId))
      expect(run.requested_by).toBe(users.idOf('operator'))
      expect(JSON.parse(run.submission_snapshot)).toEqual([agentRef(ready)])
      expect(decodeResolvedOfficialLlmPolicy(run.llm_policy_snapshot)).toEqual({
        enabled: false,
        models: {},
        session: { token_budget: 100_000, rate_limit_rpm: 60 },
      })
      // The concrete schedule was persisted before enqueue: two submitted games + two Naive games.
      const games = await storage.listRunGames(runId)
      expect(games).toHaveLength(4)
    })

    it('draws fresh seeds for a match with an empty seed list, shared across its seatings', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, {
        deps_version: 1,
        matches: [{ seats: ['submission'], seeds: [], games: 2 }],
      })
      await makeReadySubmission(storage, id)

      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(201)
      const runId = (res.json() as { id: string }).id
      const seeds = (await storage.listRunGames(runId)).map((game) => game.seed)
      // One ready submission x 2 games, then the Naive baseline on the same two drawn seeds.
      expect(seeds).toHaveLength(4)
      for (const seed of seeds) {
        expect(Number.isInteger(seed)).toBe(true)
        expect(seed).toBeGreaterThanOrEqual(0)
      }
      expect(seeds.slice(2)).toEqual(seeds.slice(0, 2))
    })

    it('expands a seat-order-sensitive (Hearts) season as ordered permutations at trigger', async () => {
      // A Hearts season (seat_order_matters=true) with a two-submission-seat match and two ready
      // submissions must schedule the ordered permutations (AB and BA), not the single unordered
      // roster. This proves the environment's seat_order_matters actually reaches the scheduler at
      // trigger rather than a hardcoded false, which would silently mis-rank a positional game.
      const declared = await app.inject({
        method: 'POST',
        url: '/api/admin/environments/hearts/seasons',
        headers: OPERATOR,
        payload: {},
      })
      expect(declared.statusCode).toBe(201)
      const heartsSeason = (declared.json() as { id: string }).id

      await storage.updateSeasonConfig(heartsSeason, {
        deps_version: 1,
        matches: [
          {
            seats: ['submission', 'submission', 'builtin:naive', 'builtin:naive'],
            seeds: [1],
            games: 1,
          },
        ],
      })
      await makeReadySubmission(storage, heartsSeason, { env: 'hearts', user: 'alice' })
      await makeReadySubmission(storage, heartsSeason, { env: 'hearts', user: 'bob' })

      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${heartsSeason}/runs`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(201)
      const runId = (res.json() as { id: string }).id
      // Ordered P(2,2) = 2 submitted seatings + 1 Naive baseline = 3 games. Unordered C(2,2) = 1
      // seating + baseline would give 2, so this count is the seat-order regression guard.
      expect(await storage.listRunGames(runId)).toHaveLength(3)
    })

    it.each<[string, MatchConfig['seats'], RegExp]>([
      ['undeclared builtin', ['builtin:unknown', 'submission'], /not declared/],
      [
        'wrong restricted builtin',
        ['builtin:naive', 'submission'],
        /must use builtin:scripted_hero/,
      ],
      ['wrong row width', ['builtin:scripted_hero'], /resolved layout count/],
    ])('rejects a stored %s matchup before creating a run', async (_name, seats, reason) => {
      const id = await declare(RESTRICTED_ENV_ID)
      await storage.updateSeasonConfig(id, {
        deps_version: 1,
        matches: [{ seats, seeds: [1], games: 1 }],
      })

      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid_config',
        reason: expect.stringMatching(reason),
      })
      expect(await storage.listRunsBySeason(id)).toEqual([])
    })

    it('rejects an empty schedule with 409 empty_schedule', async () => {
      const id = await declare() // default config has no matches
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({ code: 'empty_schedule' })
      expect(runner.enqueued).toEqual([])
    })

    it('rejects a stored override the declarations reject with a typed 400, not an untyped 500', async () => {
      const id = await declare()
      // Written through storage, the way a config saved against older declarations survives: only the
      // admin write path checks values against the environment, and the codec is structure-only.
      await storage.updateSeasonConfig(
        id,
        flappyConfig({ overrides: { parameters: { pipe_gap: 9999 } } }),
      )
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid_parameters' })
      expect((res.json() as { reason: string }).reason).toContain('pipe_gap')
      expect(runner.enqueued).toEqual([])
      expect(await storage.listRunsBySeason(id)).toEqual([])
    })

    it('refuses a second trigger while a run is in progress with 409 run_in_progress', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      const first = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(first.statusCode).toBe(201)
      const second = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(second.statusCode).toBe(409)
      expect(second.json()).toMatchObject({ code: 'run_in_progress' })
    })

    it('cancels an in-progress run through the runner stub', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      const run = (
        await app.inject({
          method: 'POST',
          url: `/api/admin/seasons/${id}/runs`,
          headers: OPERATOR,
        })
      ).json() as { id: string }
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs/${run.id}/cancel`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(202)
      expect(runner.cancelled).toEqual([run.id])
      expect((await storage.getRun(run.id))?.status).toBe('cancelled')
    })

    it('404s a cancel for a run that does not belong to the season', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/seasons/${id}/runs/ghost/cancel`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('status and list', () => {
    it('reports the same active ready-submission roster count a run would snapshot', async () => {
      const id = await declare()
      await users.headersFor('bob')
      await users.headersFor('alice')
      await users.headersFor('dave')
      const ready = await makeReadySubmission(storage, id, { user: users.idOf('bob') })
      await seedSubmission(id, users.idOf('carol'), { withSnapshot: false })

      // Replacing Alice's ready submission supersedes it, so it must not remain eligible.
      await makeReadySubmission(storage, id, { user: users.idOf('alice') })
      await seedSubmission(id, users.idOf('alice'), { withSnapshot: false })

      const otherSeason = await declare()
      await makeReadySubmission(storage, otherSeason, { user: users.idOf('dave') })

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}`,
        headers: OPERATOR,
      })

      expect(res.statusCode).toBe(200)
      expect((res.json() as { eligible_submission_count: number }).eligible_submission_count).toBe(
        1,
      )
      expect(
        (await storage.listActiveSubmissionsBySeason(id, 'ready')).map(
          (submission) => submission.id,
        ),
      ).toEqual([ready.id])
    })

    it('returns the admin view, including an unreleased season board after a completed run', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(
        id,
        flappyConfig({
          overrides: { parameters: { pipe_gap: 75 }, step_timeout_ms: 250 },
        }),
      )
      // A completed run with one Naive result, so the (still unreleased) board has a row.
      const run = await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )
      const games = await storage.listRunGames(run.id)
      await storage.recordGameResult({
        game_id: first(games).id,
        seat_index: 0,
        agent: { kind: 'builtin', name: 'naive' },
        episode_score: 7,
        agent_compute_ms_total: 4,
        acted_tick_count: 2,
        failed: false,
      })
      await storage.setRunStatus(run.id, 'completed')

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        season: { release_status: string; config: SeasonConfig }
        settings: { values: Record<string, unknown>; rules: Record<string, unknown> }
        latest_run: { id: string; status: string; games: unknown[] }
        board: { automated: Array<{ mean_score: number }> }
      }
      expect(body.season.release_status).toBe('unreleased')
      expect(body.settings).toEqual({
        values: { players: 1, pipe_gap: 75 },
        rules: {
          step_timeout_ms: 250,
          episode_timeout_ms: 120_000,
          messaging_enabled: false,
          message_cap: null,
          llm_enabled: false,
        },
      })
      expect(body.settings).not.toHaveProperty('template_repo')
      expect(body.latest_run.id).toBe(run.id)
      expect(body.latest_run.games).toHaveLength(1)
      expect(body.board.automated).toHaveLength(1)
      expect(first(body.board.automated).mean_score).toBe(7)
    })

    it('404s the status route for an unknown season', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/seasons/nope',
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(404)
    })

    it('enriches the season view run and board rows with owner display names', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      const carolId = users.idOf('carol')
      const submission = await seedSubmission(id, carolId, { withSnapshot: false })
      const ref = agentRef(submission)
      const run = await createRun(
        id,
        users.idOf('operator'),
        [ref],
        [{ match_index: 0, game_index: 0, seed: 1, seats: [ref], seat_plan: 'solo' }],
      )
      const games = await storage.listRunGames(run.id)
      await storage.recordGameResult({
        game_id: first(games).id,
        seat_index: 0,
        agent: ref,
        episode_score: 7,
        agent_compute_ms_total: 4,
        acted_tick_count: 2,
        failed: false,
      })
      await storage.setRunStatus(run.id, 'completed')

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        latest_run: {
          requested_by_name?: string
          submission_snapshot: Array<Record<string, unknown>>
          games: Array<{ seats: Array<Record<string, unknown>> }>
        }
        board: {
          automated: Array<{ agent: Record<string, unknown> }>
          games: Array<{ seats: Array<Record<string, unknown>> }>
        }
      }
      // The embedded latest run is enriched exactly like the run detail...
      expect(body.latest_run.requested_by_name).toBe('operator')
      expect(first(body.latest_run.submission_snapshot)).toMatchObject({
        user_id: carolId,
        user_name: 'carol',
      })
      expect(first(first(body.latest_run.games).seats)).toMatchObject({ user_name: 'carol' })
      // ...and the board rows plus the matchup table carry the same enriched agent ref.
      expect(first(body.board.automated).agent).toMatchObject({
        user_id: carolId,
        user_name: 'carol',
      })
      expect(first(first(body.board.games).seats)).toMatchObject({ user_name: 'carol' })
    })
  })

  describe('runs list and detail', () => {
    it("lists a season's runs newest first with game counts and no snapshots", async () => {
      const id = await declare()
      // Two runs created in order: the second (more games) must come back first. The first is
      // requested by a rowless raw id, the second by the minted operator, so the summary's
      // requested_by_name enrichment and its id fallback are both on the wire.
      await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )
      const second = await createRun(
        id,
        users.idOf('operator'),
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
          {
            match_index: 0,
            game_index: 1,
            seed: 2,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}/runs`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as Array<Record<string, unknown>>
      expect(body).toHaveLength(2)
      // Newest first: the second-created run heads the list (rowid breaks a shared-millisecond tie).
      expect(body[0]).toMatchObject({
        id: second.id,
        game_count: 2,
        requested_by: users.idOf('operator'),
        requested_by_name: 'operator',
      })
      expect(body[1]).toMatchObject({ game_count: 1, requested_by: 'dev-user' })
      // No user row for 'dev-user', so the summary carries no display name for it.
      expect(body[1]).not.toHaveProperty('requested_by_name')
      // Summaries omit the frozen snapshots.
      expect(body[0]).not.toHaveProperty('config_snapshot')
      expect(body[0]).not.toHaveProperty('submission_snapshot')
    })

    it("returns a single run's full view with its games", async () => {
      const id = await declare()
      const run = await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}/runs/${run.id}`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        id: string
        config_snapshot: SeasonConfig
        games: unknown[]
      }
      expect(body.id).toBe(run.id)
      expect(body.games).toHaveLength(1)
      // The detail view carries the full run, including the frozen config snapshot.
      expect(body.config_snapshot).toBeTruthy()
      // 'dev-user' has no user row, so no display name is attached (the id is the fallback).
      expect(body).not.toHaveProperty('requested_by_name')
    })

    it('enriches the run detail with requester, roster, and seat display names', async () => {
      const id = await declare()
      const carolId = users.idOf('carol')
      const known = await seedSubmission(id, carolId, { withSnapshot: false })
      const orphaned = await seedSubmission(id, 'ghost-user', { withSnapshot: false })
      const knownRef = agentRef(known)
      const orphanedRef = agentRef(orphaned)
      const run = await createRun(
        id,
        users.idOf('operator'),
        [knownRef, orphanedRef],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [knownRef, orphanedRef],
            seat_plan: 'solo',
          },
        ],
      )

      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}/runs/${run.id}`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
      const body = res.json() as {
        requested_by: string
        requested_by_name?: string
        submission_snapshot: Array<Record<string, unknown>>
        games: Array<{ seats: Array<Record<string, unknown>> }>
      }
      expect(body).toMatchObject({
        requested_by: users.idOf('operator'),
        requested_by_name: 'operator',
      })
      // Both the frozen roster and the scheduled seats carry the owner's name beside the stable id;
      // an owner id with no user row keeps its id and simply omits user_name.
      for (const refs of [body.submission_snapshot, first(body.games).seats]) {
        expect(refs.find((ref) => ref.user_id === carolId)).toMatchObject({ user_name: 'carol' })
        expect(refs.find((ref) => ref.user_id === 'ghost-user')).not.toHaveProperty('user_name')
      }
    })

    it('404s a run detail for an unknown run or one from another season', async () => {
      const id = await declare()
      const other = await declare()
      const run = await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )

      const unknown = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}/runs/ghost`,
        headers: OPERATOR,
      })
      expect(unknown.statusCode).toBe(404)

      // A real run requested under a different season id is hidden, not leaked.
      const crossSeason = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${other}/runs/${run.id}`,
        headers: OPERATOR,
      })
      expect(crossSeason.statusCode).toBe(404)
    })

    it('404s the runs list for an unknown season', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/seasons/nope/runs',
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('log stream (WebSocket)', () => {
    it('relays the stub runner emitted lines and closes on the terminal event', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      const run = (
        await app.inject({
          method: 'POST',
          url: `/api/admin/seasons/${id}/runs`,
          headers: OPERATOR,
        })
      ).json() as { id: string }

      const ws = await app.injectWS(`/api/admin/seasons/${id}/runs/${run.id}/logs/ws`, {
        headers: OPERATOR,
      })
      const messages: string[] = []
      ws.on('message', (data: Buffer) => messages.push(data.toString()))

      // Wait for the route to subscribe, then drive the live stream.
      await waitFor(() => runner.subscriberCount(run.id) > 0)
      const logEvent = {
        type: 'log' as const,
        game_index: 0,
        match_index: 0,
        ts: 1_700_000_000_000,
        level: 'info' as const,
        line: 'container started',
      }
      runner.emit(run.id, logEvent)
      runner.emit(run.id, { type: 'game_status', game_index: 0, status: 'running' })
      runner.emit(run.id, { type: 'terminal', status: 'completed' })

      await new Promise((resolve) => ws.on('close', resolve))
      const parsed = messages.map((m) => JSON.parse(m))
      expect(parsed).toEqual([
        logEvent,
        { type: 'game_status', game_index: 0, status: 'running' },
        { type: 'terminal', status: 'completed' },
      ])
    })

    it('sends an immediate terminal and closes for an already-finished run', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      const run = await createRun(
        id,
        'dev-user',
        [],
        [
          {
            match_index: 0,
            game_index: 0,
            seed: 1,
            seats: [{ kind: 'builtin', name: 'naive' }],
            seat_plan: 'solo',
          },
        ],
      )
      await storage.setRunStatus(run.id, 'completed')

      const ws = await app.injectWS(`/api/admin/seasons/${id}/runs/${run.id}/logs/ws`, {
        headers: OPERATOR,
      })
      const messages: string[] = []
      ws.on('message', (data: Buffer) => messages.push(data.toString()))
      await new Promise((resolve) => ws.on('close', resolve))
      expect(messages.map((m) => JSON.parse(m))).toEqual([
        { type: 'terminal', status: 'completed' },
      ])
    })
  })
})

/** Create a `ready` submission in a season and return its row. Defaults to a Flappy Bird agent by
 *  `alice`; the trigger tests override the environment and user to seed several ready agents at once. */
async function makeReadySubmission(
  storage: Storage,
  seasonId: string,
  opts: { env?: string; user?: string } = {},
) {
  const submission = await storage.createSubmission({
    season_id: seasonId,
    env_id: opts.env ?? ENV_ID,
    user_id: opts.user ?? 'alice',
    source_kind: 'git',
    repo_url: 'https://example.test/repo',
    commit_sha: 'sha1',
    local_path: null,
    ref: null,
    created_at: new Date().toISOString(),
  })
  await storage.updateSubmissionStatus(submission.id, 'ready')
  return submission
}

/** The submitted-agent ref for a submission row. */
function agentRef(submission: { id: string; user_id: string }) {
  return { kind: 'submission' as const, submission_id: submission.id, user_id: submission.user_id }
}

/** Narrow away `undefined`/`null` with a clear failure, so a test bug surfaces instead of a type cast. */
function defined<T>(value: T | undefined | null, message = 'expected a defined value'): T {
  if (value === undefined || value === null) {
    throw new Error(message)
  }
  return value
}

/** The first element of a list the test knows is non-empty. */
function first<T>(items: readonly T[]): T {
  return defined(items[0], 'expected a non-empty list')
}
