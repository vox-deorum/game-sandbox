/**
 * The public leaderboard and history reads (Stage 6.3), Docker-free. These prove the route-boundary
 * guarantee: board/history reads return only `released` iterations, while an open submission or play
 * window is still reported as a public target without exposing the iteration's boards.
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
import type { Iteration, Storage } from '../../src/storage/index.js'
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

  /** Declare an iteration directly in storage and return its row. */
  async function declare(): Promise<Iteration> {
    return storage.createIteration({ env_id: ENV_ID, deps_version: 1, label: null })
  }

  it('lists only released iterations for history, newest first', async () => {
    const unreleased = await declare()
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/iterations` })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toEqual([released.id])
    expect(ids).not.toContain(unreleased.id)
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
      submission_iteration_id: string | null
      play_iteration_id: string | null
    }
    // Nothing released → empty current board, but the submit and play targets are still reported even
    // though both their iterations are unreleased.
    expect(body.current).toBeNull()
    expect(body.submission_iteration_id).toBe(submitTarget.id)
    expect(body.play_iteration_id).toBe(playTarget.id)
  })

  it('returns the released current iteration and both boards', async () => {
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const res = await app.inject({ method: 'GET', url: `/api/environments/${ENV_ID}/leaderboards` })
    const body = res.json() as {
      current: { iteration: { id: string }; board: { automated: unknown[]; human: unknown[] } }
    }
    expect(body.current.iteration.id).toBe(released.id)
    expect(body.current.board).toEqual({ automated: [], human: [] })
  })

  it('serves a specific released iteration board and 404s an unreleased one', async () => {
    const unreleased = await declare()
    const released = await declare()
    await storage.setReleaseStatus(released.id, 'released')

    const ok = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/iterations/${released.id}/leaderboards`,
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { iteration: { id: string } }).iteration.id).toBe(released.id)

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/iterations/${unreleased.id}/leaderboards`,
    })
    expect(hidden.statusCode).toBe(404)

    const unknown = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/iterations/ghost/leaderboards`,
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

  it('returns only placements from released iterations', async () => {
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
      placements: Array<{ iteration_id: string; mean_score: number; recording_id: string | null }>
    }
    expect(body.placements).toEqual([
      expect.objectContaining({
        iteration_id: released.id,
        mean_score: 7,
        recording_id: 'visible-recording',
      }),
    ])
  })
})

/** Create a submission row for a test profile. */
async function makeSubmission(storage: Storage, iterationId: string, userId: string) {
  return storage.createSubmission({
    iteration_id: iterationId,
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
