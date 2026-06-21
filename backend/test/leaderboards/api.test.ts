/**
 * The public leaderboard and history reads (Stage 6.3), Docker-free. These prove the route-boundary
 * guarantee: board/history reads return only `released` seasons, while an open submission or play
 * window is still reported as a public target without exposing the season's boards.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { RecordingsStore } from '../../src/recordings.js'
import { Retention } from '../../src/retention.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import type { Season, Storage } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { FakeDriver } from '../support/fake-driver.js'
import { makeConfig, makeEnvironments, makeSubmissionDeps } from '../support/harness.js'

const ENV_ID = 'flappy_bird'

describe('public leaderboard API', () => {
  let app: FastifyInstance
  let storage: Storage
  let orchestrator: Orchestrator
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-lb-'))
    storage = await openSqliteStorage(':memory:')
    const config = makeConfig({ recordingsDir: dir })
    const environments = makeEnvironments()
    orchestrator = new Orchestrator(new FakeDriver(), storage, environments, config)
    const recordings = new RecordingsStore(dir)
    app = await buildApp({
      orchestrator,
      environments,
      recordings,
      retention: new Retention(storage, recordings, config),
      allowlist: ['dev-user'],
      ...makeSubmissionDeps(storage, config),
    })
  })

  afterEach(async () => {
    await orchestrator.shutdown()
    await app.close()
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Declare a season directly in storage and return its row. */
  async function declare(): Promise<Season> {
    return storage.createSeason({ env_id: ENV_ID, deps_version: 1, label: null })
  }

  it('lists only released seasons for history, newest first', async () => {
    const unreleased = await declare()
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/seasons` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toEqual([released.id])
    expect(ids).not.toContain(unreleased.id)
  })

  it('lists every public-facing season across the three flags, without boards', async () => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')
    const submitOpen = await declare()
    await storage.setSubmissionStatus(submitOpen.id, 'open')
    const playOpen = await declare()
    await storage.setPlayStatus(playOpen.id, 'open')
    const hidden = await declare() // closed and unreleased — never public

    const res = await app.inject({ method: 'GET', url: '/api/seasons' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<Record<string, unknown> & { id: string }>
    const ids = body.map((s) => s.id)
    expect(new Set(ids)).toEqual(new Set([released.id, submitOpen.id, playOpen.id]))
    expect(ids).not.toContain(hidden.id)
    // The index exposes only public listing metadata. Unreleased configuration, rating prompts, and
    // board payloads stay behind their operator/released-only routes.
    expect(
      body.every(
        (season) =>
          season.config === undefined &&
          season.rating_prompt === undefined &&
          season.board === undefined &&
          typeof season.submission_count === 'number' &&
          typeof season.session_count === 'number',
      ),
    ).toBe(true)
  })

  it('lets an operator list every season — including fully-private ones — with ?includeUnreleased=true', async () => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')
    const hidden = await declare() // closed and unreleased — never public

    // The default mock user (`dev-user`) is an operator, so an unauthenticated inject is one here.
    const res = await app.inject({
      method: 'GET',
      url: `/api/seasons?envId=${ENV_ID}&includeUnreleased=true`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<Record<string, unknown> & { id: string }>
    expect(body.map((s) => s.id)).toEqual([hidden.id, released.id])
    // Still the public listing shape: config, rating prompts, and boards stay out, counts stay in.
    expect(
      body.every(
        (season) =>
          season.config === undefined &&
          season.rating_prompt === undefined &&
          typeof season.submission_count === 'number',
      ),
    ).toBe(true)
  })

  it('refuses ?includeUnreleased=true for a non-operator with 403 not_operator', async () => {
    const hidden = await declare()

    const res = await app.inject({
      method: 'GET',
      url: `/api/seasons?envId=${ENV_ID}&includeUnreleased=true`,
      headers: { 'x-sandbox-user': 'carol' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ code: 'not_operator' })

    // The flagless public list stays open to everyone and still hides the fully-private season.
    const open = await app.inject({
      method: 'GET',
      url: `/api/seasons?envId=${ENV_ID}`,
      headers: { 'x-sandbox-user': 'carol' },
    })
    expect(open.statusCode).toBe(200)
    expect((open.json() as Array<{ id: string }>).map((s) => s.id)).not.toContain(hidden.id)
  })

  it('counts active submissions and ended attributed sessions in the public season index', async () => {
    const season = await declare()
    await storage.setReleaseStatus(season.id, 'released')

    await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'git',
      repo_url: 'https://example.test/alice/first',
      commit_sha: 'sha-1',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:00:00.000Z',
    })
    await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'alice',
      source_kind: 'git',
      repo_url: 'https://example.test/alice/current',
      commit_sha: 'sha-2',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:01:00.000Z',
    })
    await storage.createSubmission({
      season_id: season.id,
      env_id: ENV_ID,
      user_id: 'bob',
      source_kind: 'git',
      repo_url: 'https://example.test/bob/current',
      commit_sha: 'sha-3',
      local_path: null,
      ref: null,
      created_at: '2026-06-11T00:02:00.000Z',
    })

    await storage.createSession({
      id: 'ended-season-session',
      user_id: 'viewer',
      env_id: ENV_ID,
      mode: 'scripted',
      recording_id: 'ended-recording',
      season_id: season.id,
      created_at: '2026-06-11T01:00:00.000Z',
    })
    await storage.markEnded('ended-season-session', 'terminated', '2026-06-11T01:01:00.000Z')
    await storage.createSession({
      id: 'active-season-session',
      user_id: 'viewer-2',
      env_id: ENV_ID,
      mode: 'human',
      recording_id: null,
      season_id: season.id,
      created_at: '2026-06-11T02:00:00.000Z',
    })
    await storage.createSession({
      id: 'ended-unattributed-session',
      user_id: 'viewer-3',
      env_id: ENV_ID,
      mode: 'human',
      recording_id: 'unattributed-recording',
      season_id: null,
      created_at: '2026-06-11T03:00:00.000Z',
    })
    await storage.markEnded('ended-unattributed-session', 'terminated', '2026-06-11T03:01:00.000Z')

    const res = await app.inject({ method: 'GET', url: '/api/seasons' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      expect.objectContaining({
        id: season.id,
        submission_count: 2,
        session_count: 1,
      }),
    ])
  })

  it('narrows the public seasons list to one environment with ?envId=', async () => {
    const here = await declare()
    await storage.setReleaseStatus(here.id, 'released')
    const elsewhere = await storage.createSeason({
      env_id: 'turn_based',
      deps_version: 1,
      label: null,
    })
    await storage.setReleaseStatus(elsewhere.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/seasons?envId=${ENV_ID}` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((s) => s.id)
    expect(ids).toEqual([here.id])
    expect(ids).not.toContain(elsewhere.id)
  })

  it('returns an empty current board when nothing is released, plus the public targets', async () => {
    const submitTarget = await declare()
    await storage.setSubmissionStatus(submitTarget.id, 'open')
    const playTarget = await declare()
    await storage.setPlayStatus(playTarget.id, 'open')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/leaderboards` })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      current: unknown
      submission_season_id: string | null
      play_season_id: string | null
    }
    // Nothing released → empty current board, but the submit and play targets are still reported even
    // though both their seasons are unreleased.
    expect(body.current).toBeNull()
    expect(body.submission_season_id).toBe(submitTarget.id)
    expect(body.play_season_id).toBe(playTarget.id)
  })

  it('returns the released current season and both boards', async () => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/leaderboards` })
    const body = res.json() as {
      current: { season: { id: string }; board: { automated: unknown[]; human: unknown[] } }
    }
    expect(body.current.season.id).toBe(released.id)
    expect(body.current.board).toEqual({ automated: [], human: [] })
  })

  it('serves a specific released season board and 404s an unreleased one', async () => {
    const unreleased = await declare()
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const ok = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/seasons/${released.id}/leaderboards`,
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { season: { id: string } }).season.id).toBe(released.id)

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/seasons/${unreleased.id}/leaderboards`,
    })
    expect(hidden.statusCode).toBe(404)

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/seasons/ghost/leaderboards`,
    })
    expect(unknown.statusCode).toBe(404)
  })

  it('returns an empty placements payload for an owner with no submissions', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/nobody/placements`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ env_id: ENV_ID, owner_id: 'nobody', placements: [] })
  })

  it('returns only placements from released seasons', async () => {
    const unreleased = await declare()
    const hidden = await makeSubmission(storage, unreleased.id, 'alice')
    const hiddenRun = await storage.createRunWithSchedule(
      unreleased.id,
      'dev-user',
      [agentRef(hidden)],
      [{ match_index: 0, game_index: 0, seed: 1, slots: [agentRef(hidden)] }],
    )
    await storage.replaceAutomatedPlacements(unreleased.id, ENV_ID, hiddenRun.id, [
      {
        rank: 1,
        agent: agentRef(hidden),
        mean_score: 99,
        mean_agent_compute_ms: 1,
        failure_count: 0,
        recording_id: 'hidden-recording',
      },
    ])

    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')
    const visible = await makeSubmission(storage, released.id, 'alice')
    const visibleRun = await storage.createRunWithSchedule(
      released.id,
      'dev-user',
      [agentRef(visible)],
      [{ match_index: 0, game_index: 0, seed: 1, slots: [agentRef(visible)] }],
    )
    await storage.replaceAutomatedPlacements(released.id, ENV_ID, visibleRun.id, [
      {
        rank: 1,
        agent: agentRef(visible),
        mean_score: 7,
        mean_agent_compute_ms: 2,
        failure_count: 0,
        recording_id: 'visible-recording',
      },
    ])

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/alice/placements`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      placements: Array<{ season_id: string; mean_score: number; recording_id: string | null }>
    }
    expect(body.placements).toEqual([
      expect.objectContaining({
        season_id: released.id,
        mean_score: 7,
        recording_id: 'visible-recording',
      }),
    ])
  })
})

/** Create a submission row for a test profile. */
async function makeSubmission(storage: Storage, seasonId: string, userId: string) {
  return storage.createSubmission({
    season_id: seasonId,
    env_id: ENV_ID,
    user_id: userId,
    source_kind: 'git',
    repo_url: 'https://example.test/repo',
    commit_sha: 'sha1',
    local_path: null,
    ref: null,
    created_at: new Date().toISOString(),
  })
}

/** The submitted-agent ref for a submission row. */
function agentRef(submission: { id: string; user_id: string }) {
  return { kind: 'submission' as const, submission_id: submission.id, user_id: submission.user_id }
}
