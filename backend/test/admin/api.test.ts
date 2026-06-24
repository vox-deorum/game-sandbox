/**
 * The operator-gated admin HTTP API (Stage 6.3), Docker-free with a stub runner and `:memory:`
 * storage. These prove the gating choke point, the declare/configure/lifecycle/trigger/cancel/status
 * contract, and the live log-stream relay without touching Docker — the runner is a recording stub.
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
import type { Storage } from '../../src/storage/index.js'
import type { SeasonConfig } from '../../src/storage/season-config.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { FakeDriver } from '../support/fake-driver.js'
import { makeConfig, makeEnvironments, makeSubmissionDeps } from '../support/harness.js'
import { StubWorkflowRunner } from '../support/stub-runner.js'

const ENV_ID = 'flappy_bird'
const OPERATOR = { 'x-sandbox-user': 'dev-user' }
const STRANGER = { 'x-sandbox-user': 'carol' }

/** A valid single-submission-seat Flappy Bird config; `deps_version` overridable for the change path. */
function flappyConfig(overrides: Partial<SeasonConfig> = {}): SeasonConfig {
  return {
    deps_version: 1,
    matches: [{ slots: ['submission'], seeds: [1, 2], games: 2 }],
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
  let orchestrator: Orchestrator
  let runner: StubWorkflowRunner
  let dir: string

  async function build(
    operatorAllowlist: string[] = ['dev-user'],
    knownDepsVersions: ReadonlySet<number> = new Set([1, 2]),
  ): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'gs-admin-'))
    storage = await openSqliteStorage(':memory:')
    const config = makeConfig({ recordingsDir: dir })
    const environments = makeEnvironments()
    orchestrator = new Orchestrator(new FakeDriver(), storage, environments, config)
    const recordings = new RecordingsStore(dir)
    runner = new StubWorkflowRunner(storage)
    app = await buildApp({
      orchestrator,
      environments,
      recordings,
      retention: new Retention(storage, recordings, config),
      allowlist: ['dev-user'],
      ...makeSubmissionDeps(storage, config),
      operatorAllowlist,
      knownDepsVersions,
      workflowRunner: runner,
    })
    await app.ready()
  }

  /** Declare a season over HTTP and return its id. */
  async function declare(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/environments/${ENV_ID}/seasons`,
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
        ['PUT', `/api/admin/seasons/${id}/config`],
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

    it('proceeds for an operator (the dev mock user is one out of the box)', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/seasons/${id}`,
        headers: OPERATOR,
      })
      expect(res.statusCode).toBe(200)
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
      expect(body.config).toEqual({ deps_version: 1, matches: [] })
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
        payload: { deps_version: 3 },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid_season_declaration',
        reason: expect.stringContaining('deps_version 3 is not supported'),
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

    it('400s an invalid config with a specific reason', async () => {
      const id = await declare()
      const cases: Array<[string, Record<string, unknown>]> = [
        ['zero slots', { deps_version: 1, matches: [{ slots: [], seeds: [1], games: 1 }] }],
        [
          'empty seeds',
          { deps_version: 1, matches: [{ slots: ['submission'], seeds: [], games: 1 }] },
        ],
        [
          'non-positive games',
          { deps_version: 1, matches: [{ slots: ['submission'], seeds: [1], games: 0 }] },
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

    it('400s a match whose slot count mismatches the environment (max 1 for Flappy)', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: {
          deps_version: 1,
          matches: [{ slots: ['submission', 'builtin-naive'], seeds: [1], games: 1 }],
        },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'invalid_config' })
      expect((res.json() as { reason: string }).reason).toMatch(/exceeds the environment maximum/)
    })

    it('400s a config whose dependency version has no deployment image definition', async () => {
      const id = await declare()
      const res = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config`,
        headers: OPERATOR,
        payload: flappyConfig({ deps_version: 3 }),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({
        code: 'invalid_config',
        reason: expect.stringContaining('deps_version 3 is not supported'),
      })
    })

    it('refuses a config edit against existing runs without force, and succeeds with force', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      // A run plus a result and a placement, all of which a forced edit must clear.
      const ready = await makeReadySubmission(storage, id)
      const run = await storage.createRunWithSchedule(
        id,
        'dev-user',
        [agentRef(ready)],
        [{ match_index: 0, game_index: 0, seed: 1, slots: [agentRef(ready)] }],
      )
      const games = await storage.listRunGames(run.id)
      await storage.recordGameResult({
        game_id: first(games).id,
        slot_index: 0,
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
        payload: flappyConfig({ matches: [{ slots: ['submission'], seeds: [9], games: 1 }] }),
      })
      expect(refused.statusCode).toBe(409)
      expect(refused.json()).toMatchObject({ code: 'season_has_runs' })
      expect(runner.cancelled).toEqual([])

      const forced = await app.inject({
        method: 'PUT',
        url: `/api/admin/seasons/${id}/config?force=true`,
        headers: OPERATOR,
        payload: flappyConfig({ matches: [{ slots: ['submission'], seeds: [9], games: 1 }] }),
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

  describe('rating prompt', () => {
    it('sets the operator prompt even after a run exists (never gated by the config rules)', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      await storage.createRunWithSchedule(
        id,
        'dev-user',
        [],
        [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
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
      expect(run.requested_by).toBe('dev-user')
      expect(JSON.parse(run.submission_snapshot)).toEqual([agentRef(ready)])
      // The concrete schedule was persisted before enqueue: two submitted games + two Naive games.
      const games = await storage.listRunGames(runId)
      expect(games).toHaveLength(4)
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
    it('returns the admin view, including an unreleased season board after a completed run', async () => {
      const id = await declare()
      await storage.updateSeasonConfig(id, flappyConfig())
      // A completed run with one Naive result, so the (still unreleased) board has a row.
      const run = await storage.createRunWithSchedule(
        id,
        'dev-user',
        [],
        [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
      )
      const games = await storage.listRunGames(run.id)
      await storage.recordGameResult({
        game_id: first(games).id,
        slot_index: 0,
        agent: { kind: 'builtin-naive' },
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
        latest_run: { id: string; status: string; games: unknown[] }
        board: { automated: Array<{ mean_score: number }> }
      }
      expect(body.season.release_status).toBe('unreleased')
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
  })

  describe('runs list and detail', () => {
    it("lists a season's runs newest first with game counts and no snapshots", async () => {
      const id = await declare()
      // Two runs created in order: the second (more games) must come back first.
      await storage.createRunWithSchedule(
        id,
        'dev-user',
        [],
        [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
      )
      const second = await storage.createRunWithSchedule(
        id,
        'dev-user',
        [],
        [
          { match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] },
          { match_index: 0, game_index: 1, seed: 2, slots: [{ kind: 'builtin-naive' }] },
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
      expect(body[0]).toMatchObject({ id: second.id, game_count: 2 })
      expect(body[1]).toMatchObject({ game_count: 1 })
      // Summaries omit the frozen snapshots.
      expect(body[0]).not.toHaveProperty('config_snapshot')
      expect(body[0]).not.toHaveProperty('submission_snapshot')
    })

    it("returns a single run's full view with its games", async () => {
      const id = await declare()
      const run = await storage.createRunWithSchedule(
        id,
        'dev-user',
        [],
        [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
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
    })

    it('404s a run detail for an unknown run or one from another season', async () => {
      const id = await declare()
      const other = await declare()
      const run = await storage.createRunWithSchedule(
        id,
        'dev-user',
        [],
        [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
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

      const ws = await app.injectWS(`/api/admin/seasons/${id}/runs/${run.id}/logs/ws?user=dev-user`)
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
      const run = await storage.createRunWithSchedule(
        id,
        'dev-user',
        [],
        [{ match_index: 0, game_index: 0, seed: 1, slots: [{ kind: 'builtin-naive' }] }],
      )
      await storage.setRunStatus(run.id, 'completed')

      const ws = await app.injectWS(`/api/admin/seasons/${id}/runs/${run.id}/logs/ws?user=dev-user`)
      const messages: string[] = []
      ws.on('message', (data: Buffer) => messages.push(data.toString()))
      await new Promise((resolve) => ws.on('close', resolve))
      expect(messages.map((m) => JSON.parse(m))).toEqual([
        { type: 'terminal', status: 'completed' },
      ])
    })
  })
})

/** Create a `ready` submission in a season and return its row. */
async function makeReadySubmission(storage: Storage, seasonId: string) {
  const submission = await storage.createSubmission({
    season_id: seasonId,
    env_id: ENV_ID,
    user_id: 'alice',
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
