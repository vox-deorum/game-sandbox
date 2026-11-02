/** Ratings and author prompts through HTTP, using real auth, SQLite, and recording files. */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { Retention } from '../../src/recordings/retention.js'
import { RecordingsStore } from '../../src/recordings/store.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import type { GameStatus, Season, Storage } from '../../src/storage/index.js'
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

const ENV_ID = 'flappy_bird'

/** A header `players` entry as the recording schema shapes it. */
type PlayerEntry =
  | { kind: 'human'; label: string; user?: string }
  | { kind: 'agent'; label: string; submission_id: string; user?: string }
  | { kind: 'agent'; label: string; builtin_name: string }

describe('rating API', () => {
  let app: FastifyInstance
  let storage: Storage
  let users: TestUsers
  let orchestrator: Orchestrator
  let dir: string
  // Cookie headers and the Better Auth ids behind them, minted fresh per test.
  let BOB: Record<string, string>
  let ALICE: Record<string, string>
  let OPERATOR: Record<string, string>
  let aliceId: string
  let bobId: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-rate-'))
    const stack = await openTestStack()
    storage = stack.storage
    users = stack.users
    BOB = await users.headersFor('bob')
    ALICE = await users.headersFor('alice')
    OPERATOR = await users.headersFor('operator', { status: 'admin' })
    aliceId = users.idOf('alice')
    bobId = users.idOf('bob')
    const config = makeConfig({ recordingsDir: dir })
    const environments = makeEnvironments()
    orchestrator = new Orchestrator({ driver: new FakeDriver(), storage, environments, config })
    const recordings = new RecordingsStore(dir)
    app = await buildApp({
      orchestrator,
      environments,
      recordings,
      retention: new Retention(storage, recordings, config),
      auth: stack.auth,
      userDirectory: stack.userDirectory,
      llm: config.llm,
      templateRepoUrl: config.templateRepoUrl,
      ...makeSubmissionDeps(storage, config),
    })
    await app.ready()
  })

  afterEach(async () => {
    await orchestrator.shutdown()
    await app.close()
    await storage.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A play-open season (createSeason starts play-closed), with an optional operator prompt. */
  async function playOpenSeason(ratingPrompt?: string): Promise<Season> {
    const season = await storage.createSeason({ env_id: ENV_ID, deps_version: 1 })
    const opened = await storage.setPlayStatus(season.id, 'open')
    if (!opened.ok) {
      throw new Error('could not open play')
    }
    if (ratingPrompt !== undefined) {
      await storage.setSeasonRatingPrompt(season.id, ratingPrompt)
    }
    return (await storage.getSeason(season.id)) as Season
  }

  /** Create a submission row for `userId` in the season; status is irrelevant to rating. */
  async function submissionFor(seasonId: string, userId: string): Promise<string> {
    const submission = await storage.createSubmission({
      season_id: seasonId,
      env_id: ENV_ID,
      user_id: userId,
      source_kind: 'git',
      repo_url: 'https://example.test/agent',
      commit_sha: 'sha1',
      local_path: null,
      ref: null,
      created_at: new Date().toISOString(),
    })
    return submission.id
  }

  /** Write a recording with a `players` header, returning its id. */
  async function writeRecording(id: string, players: Record<string, PlayerEntry>): Promise<string> {
    await mkdir(join(dir, id), { recursive: true })
    const header = {
      schema_version: 1,
      environment: ENV_ID,
      parameters: { players: 1, pipe_gap: 100 },
      players,
      seats: Object.fromEntries(
        Object.keys(players).map((player, index) => [`seat_${index}`, [player]]),
      ),
      seat_plan: 'solo',
    }
    await writeFile(join(dir, id, 'recording.jsonl'), `${JSON.stringify(header)}\n`, 'utf-8')
    return id
  }

  /** Seed a session row with the given season and recording attribution; ended unless told otherwise. */
  async function seedSession(options: {
    seasonId: string | null
    recordingId: string | null
    ended?: boolean
  }): Promise<string> {
    const id = `sess-${randomUUID()}`
    await storage.createSession({
      id,
      user_id: bobId,
      env_id: ENV_ID,
      parameters: { players: 1 },
      mode: 'scripted',
      recording_id: options.recordingId,
      season_id: options.seasonId,
      created_at: new Date().toISOString(),
    })
    if (options.ended !== false) {
      // A rateable session is a finished one; the rating gate requires the session to have ended.
      await storage.markEnded(id, 'terminated', new Date().toISOString())
    }
    return id
  }

  /** A fresh play-open season with a recording that seats alice's agent as `player_0`, plus extras. */
  async function aliceRecording(
    recordingId: string,
    extraPlayers: Record<string, PlayerEntry> = {},
    ratingPrompt?: string,
  ): Promise<{ season: Season; subId: string; recId: string }> {
    const season = await playOpenSeason(ratingPrompt)
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording(recordingId, {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      ...extraPlayers,
    })
    return { season, subId, recId }
  }

  /** {@link aliceRecording} plus a finished session in that season that recorded it. */
  async function seedAliceSession(
    ...args: Parameters<typeof aliceRecording>
  ): Promise<{ season: Season; subId: string; recId: string; sessionId: string }> {
    const seeded = await aliceRecording(...args)
    const sessionId = await seedSession({ seasonId: seeded.season.id, recordingId: seeded.recId })
    return { ...seeded, sessionId }
  }

  /** Schedule a one-game run in the season whose game recorded `recordingId`, at the given status. */
  async function tournamentGame(
    seasonId: string,
    recordingId: string,
    status: GameStatus = 'completed',
  ): Promise<void> {
    const run = await createRunOrFail(storage, seasonId, users.idOf('operator'), () => ({
      parametersSnapshot: { players: 1 },
      scheduledGames: [
        {
          match_index: 0,
          game_index: 0,
          seed: 1,
          seats: [{ kind: 'builtin', name: 'naive' }],
          seat_plan: 'solo',
        },
      ],
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
    const game = (await storage.listRunGames(run.id))[0]
    if (game === undefined) {
      throw new Error('expected a scheduled game')
    }
    await storage.attachRunGameRecording(game.id, recordingId)
    await storage.setRunGameStatus(game.id, status)
  }

  it('stores submitted and distinct named builtin ratings under the authenticated caller', async () => {
    const { season, subId, sessionId } = await seedAliceSession('flappy_bird-a', {
      player_1: { kind: 'agent', builtin_name: 'cautious', label: 'Cautious bidder' },
      player_2: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 1, feedback: 'good dodge' },
          { agent: { kind: 'builtin', name: 'cautious' }, score: 5, feedback: 'steady' },
          { agent: { kind: 'builtin', name: 'naive' }, score: 3, feedback: 'predictable' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const rows = await storage.listRatingsBySeason(season.id)
    expect(rows).toHaveLength(3)
    expect(
      rows.map((row) => [
        row.rater_user_id,
        row.agent_submission_id ?? row.agent_builtin_name,
        row.score,
        row.feedback,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [bobId, subId, 1, 'good dodge'],
        [bobId, 'cautious', 5, 'steady'],
        [bobId, 'naive', 3, 'predictable'],
      ]),
    )
  })

  it('replaces one effective rating through session and replay routes without changing another rater', async () => {
    const { season, subId, recId, sessionId } = await seedAliceSession('flappy_bird-cross-route')
    const agent = { kind: 'submission' as const, submission_id: subId }
    const sessionUrl = `/api/sessions/${sessionId}/ratings`
    const replayUrl = `/api/recordings/${recId}/ratings`
    const other = await app.inject({
      method: 'POST',
      url: sessionUrl,
      headers: OPERATOR,
      payload: { ratings: [{ agent, score: 1, feedback: 'other rater' }] },
    })
    expect(other.statusCode).toBe(200)
    for (const [url, score, feedback] of [
      [sessionUrl, 2, 'first impression'],
      [replayUrl, 5, 'replay impression'],
      [sessionUrl, 3, 'revised impression'],
    ] as const) {
      const write = await app.inject({
        method: 'POST',
        url,
        headers: BOB,
        payload: { ratings: [{ agent, score, feedback }] },
      })
      expect([write.statusCode, write.json().agents]).toEqual([
        200,
        [
          expect.objectContaining({
            agent,
            your_rating: score,
            your_feedback: feedback,
          }),
        ],
      ])
      const rows = await storage.listRatingsBySeason(season.id)
      expect(rows).toHaveLength(2)
      expect(
        rows.map((row) => [row.rater_user_id, row.agent_submission_id, row.score, row.feedback]),
      ).toEqual(
        expect.arrayContaining([
          [bobId, subId, score, feedback],
          [users.idOf('operator'), subId, 1, 'other rater'],
        ]),
      )
    }
    for (const url of [sessionUrl, replayUrl]) {
      const read = await app.inject({ method: 'GET', url, headers: BOB })
      expect([read.statusCode, read.json()]).toEqual([
        200,
        expect.objectContaining({
          season_id: season.id,
          agents: [
            expect.objectContaining({ agent, your_rating: 3, your_feedback: 'revised impression' }),
          ],
        }),
      ])
    }
  })

  it.each([
    ['anonymous', 401, 'auth_required'],
    ['pending', 403, 'not_active'],
    ['guest', 403, 'not_active'],
  ] as const)('refuses %s rating participation through both routes', async (status, code, reason) => {
    const { season, subId, recId, sessionId } = await seedAliceSession('flappy_bird-not-active')
    const headers = status === 'anonymous' ? {} : await users.headersFor('mallory', { status })
    const methods = status === 'anonymous' ? (['GET', 'POST'] as const) : (['POST'] as const)
    for (const url of [`/api/sessions/${sessionId}/ratings`, `/api/recordings/${recId}/ratings`]) {
      for (const method of methods) {
        const res = await app.inject({
          method,
          url,
          headers,
          payload:
            method === 'POST'
              ? {
                  ratings: [
                    {
                      agent: { kind: 'submission', submission_id: subId },
                      score: 5,
                      feedback: 'eager',
                    },
                  ],
                }
              : undefined,
        })
        expect([res.statusCode, res.json().code]).toEqual([code, reason])
      }
    }
    expect(await storage.listRatingsBySeason(season.id)).toEqual([])
  })

  it.each([
    { score: 0, feedback: 'too low', code: 'invalid_score' },
    { score: 6, feedback: 'too high', code: 'invalid_score' },
    { score: 4, feedback: ' \n\t ', code: 'empty_feedback' },
    { score: 4, feedback: 'x'.repeat(1_001), code: 'feedback_too_long' },
    { score: 4, feedback: '😀'.repeat(1_001), code: 'feedback_too_long' },
  ])('rejects $code without saving the valid entry before it', async ({
    score,
    feedback,
    code,
  }) => {
    const { season, subId, recId, sessionId } = await seedAliceSession('flappy_bird-invalid', {
      player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    for (const url of [`/api/sessions/${sessionId}/ratings`, `/api/recordings/${recId}/ratings`]) {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: BOB,
        payload: {
          ratings: [
            { agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: 'fine' },
            { agent: { kind: 'submission', submission_id: subId }, score, feedback },
          ],
        },
      })
      expect([res.statusCode, res.json().code]).toEqual([400, code])
      expect(await storage.listRatingsBySeason(season.id)).toEqual([])
    }
  })

  it.each([
    'x'.repeat(1_000),
    '😀'.repeat(1_000),
  ])('stores a trimmed comment at the code-point cap (case %#)', async (comment) => {
    const { season, subId, sessionId } = await seedAliceSession('flappy_bird-comment')
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          {
            agent: { kind: 'submission', submission_id: subId },
            score: 4,
            feedback: ` \n${comment}\t `,
          },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect((await storage.listRatingsBySeason(season.id)).map((row) => row.feedback)).toEqual([
      comment,
    ])
  })

  it('serves the owner feedback read for released seasons only, gated to the owner', async () => {
    // Alice owns a submission in both a released and an unreleased season; only the released one may
    // surface, no matter how many ratings pile onto the hidden season.
    const released = await storage.createSeason({ env_id: ENV_ID, deps_version: 1 })
    await storage.setReleaseStatus(released.id, 'released')
    const releasedSub = await submissionFor(released.id, aliceId)
    const unreleased = await storage.createSeason({ env_id: ENV_ID, deps_version: 1 })
    const unreleasedSub = await submissionFor(unreleased.id, aliceId)
    await users.headersFor('carol')
    const carolId = users.idOf('carol')
    for (const [rater, score, comment] of [
      [bobId, 5, 'Held the gap'],
      [carolId, 3, 'Nice recovery'],
    ] as const) {
      await storage.upsertRating({
        season_id: released.id,
        env_id: ENV_ID,
        rater_user_id: rater,
        agent: { kind: 'submission', submission_id: releasedSub, user_id: aliceId },
        score,
        feedback: comment,
      })
    }
    await storage.upsertRating({
      season_id: unreleased.id,
      env_id: ENV_ID,
      rater_user_id: bobId,
      agent: { kind: 'submission', submission_id: unreleasedSub, user_id: aliceId },
      score: 1,
      feedback: 'Hidden behind release',
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/${aliceId}/feedback`,
      headers: ALICE,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      env_id: string
      owner_id: string
      seasons: Array<{
        season_id: string
        season_label: string | null
        mean: number
        count: number
        ratings: Array<{ score: number; feedback: string; rated_at: string }>
      }>
    }
    expect(body.env_id).toBe(ENV_ID)
    expect(body.owner_id).toBe(aliceId)
    expect(body.seasons).toHaveLength(1)
    const group = body.seasons[0]
    expect(group?.season_id).toBe(released.id)
    expect(group?.season_label).toBeNull()
    // (5 + 3) / 2 across the two raters.
    expect(group?.mean).toBe(4)
    expect(group?.count).toBe(2)
    expect(group?.ratings.map((r) => r.feedback).sort()).toEqual(['Held the gap', 'Nice recovery'])
    // Rater identity never leaves the server, on any row.
    for (const rating of group?.ratings ?? []) {
      expect(rating).toHaveProperty('score')
      expect(rating).toHaveProperty('feedback')
      expect(rating).toHaveProperty('rated_at')
      expect(rating).not.toHaveProperty('rater_user_id')
      expect(rating).not.toHaveProperty('rater_name')
      expect(rating).not.toHaveProperty('user_name')
    }

    // A non-owner cannot read someone else's feedback.
    const stranger = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/${aliceId}/feedback`,
      headers: BOB,
    })
    expect(stranger.statusCode).toBe(403)
    expect(stranger.json()).toMatchObject({ code: 'not_your_agent' })

    // Anonymous callers are refused before any season lookup.
    const anon = await app.inject({
      method: 'GET',
      url: `/api/environments/${ENV_ID}/agents/${aliceId}/feedback`,
    })
    expect(anon.statusCode).toBe(401)
    expect(anon.json()).toMatchObject({ code: 'auth_required' })
  })

  it('rejects a real submission that did not participate in an otherwise rateable game', async () => {
    const { season, sessionId } = await seedAliceSession('flappy_bird-outsider', {
      player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const outsider = await submissionFor(season.id, users.idOf('operator'))
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          {
            agent: { kind: 'submission', submission_id: outsider },
            score: 3,
            feedback: 'not in this game',
          },
        ],
      },
    })
    expect([res.statusCode, res.json().code]).toEqual([400, 'agent_not_in_session'])
    expect(await storage.listRatingsBySeason(season.id)).toEqual([])
  })

  it.each([
    'session',
    'tournament',
  ] as const)('resolves ownership from the submission for a %s rating', async (origin) => {
    const { season, subId, recId } = await aliceRecording('flappy_bird-own')
    await writeRecording(recId, {
      player_0: { kind: 'agent', label: 'Misleading owner', submission_id: subId, user: bobId },
    })
    const url =
      origin === 'session'
        ? `/api/sessions/${await seedSession({ seasonId: season.id, recordingId: recId })}/ratings`
        : `/api/recordings/${recId}/ratings`
    if (origin === 'tournament') await tournamentGame(season.id, recId)
    const res = await app.inject({
      method: 'POST',
      url,
      headers: ALICE,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 5, feedback: 'mine' },
        ],
      },
    })
    expect([res.statusCode, res.json().code]).toEqual([400, 'own_agent'])
    expect(await storage.listRatingsBySeason(season.id)).toEqual([])
  })

  it.each([
    { state: 'no season', code: 'not_rateable' },
    { state: 'no recording', code: 'not_finished' },
    { state: 'missing file', code: 'not_finished' },
    { state: 'running', code: 'not_finished' },
  ])('refuses reads and writes for a session with $state', async ({ state, code }) => {
    const season = state === 'no season' ? undefined : await playOpenSeason()
    const recId = state === 'no recording' ? null : 'flappy_bird-gate'
    if (recId !== null && state !== 'missing file') {
      await writeRecording(recId, {
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      })
    }
    const sessionId = await seedSession({
      seasonId: season?.id ?? null,
      recordingId: recId,
      ended: state !== 'running',
    })
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({
        method,
        url: `/api/sessions/${sessionId}/ratings`,
        headers: BOB,
        payload:
          method === 'POST'
            ? {
                ratings: [
                  { agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: 'fine' },
                ],
              }
            : undefined,
      })
      expect([res.statusCode, res.json().code]).toEqual([409, code])
    }
    if (season !== undefined) expect(await storage.listRatingsBySeason(season.id)).toEqual([])
  })

  it.each([
    'session',
    'tournament',
  ] as const)('keeps prior feedback read-only after closing play for a %s', async (origin) => {
    const { season, subId, recId } = await aliceRecording('flappy_bird-closed')
    const url =
      origin === 'session'
        ? `/api/sessions/${await seedSession({ seasonId: season.id, recordingId: recId })}/ratings`
        : `/api/recordings/${recId}/ratings`
    if (origin === 'tournament') await tournamentGame(season.id, recId)
    const agent = { kind: 'submission' as const, submission_id: subId }
    const first = await app.inject({
      method: 'POST',
      url,
      headers: BOB,
      payload: { ratings: [{ agent, score: 2, feedback: 'before closing' }] },
    })
    expect(first.statusCode).toBe(200)
    await storage.setPlayStatus(season.id, 'closed')
    const write = await app.inject({
      method: 'POST',
      url,
      headers: BOB,
      payload: { ratings: [{ agent, score: 5, feedback: 'too late' }] },
    })
    expect([write.statusCode, write.json().code]).toEqual([409, 'play_closed'])
    const read = await app.inject({ method: 'GET', url, headers: BOB })
    expect([read.statusCode, read.json()]).toEqual([
      200,
      expect.objectContaining({
        read_only: true,
        agents: [
          expect.objectContaining({ agent, your_rating: 2, your_feedback: 'before closing' }),
        ],
      }),
    ])
    expect(
      (await storage.listRatingsBySeason(season.id)).map((row) => [row.score, row.feedback]),
    ).toEqual([[2, 'before closing']])
  })

  it.each([
    { caller: 'bob', label: 'Agent 1', own: false, score: 4, feedback: 'Bold dives' },
    { caller: 'alice', label: 'Your agent', own: true, score: null, feedback: null },
  ])('reads saved feedback, prompts, and eligibility for $caller', async ({
    caller,
    label,
    own,
    score,
    feedback,
  }) => {
    const season = await playOpenSeason('Rate the overall fun')
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-view', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      player_2: { kind: 'human', label: 'bob', user: bobId },
      player_3: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })
    await storage.updateSubmissionStatus(subId, 'ready')
    await storage.upsertAgentRatingPrompt(season.id, aliceId, 'Judge my dodging')
    const saved = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 4, feedback: 'Bold dives' },
        ],
      },
    })
    expect(saved.statusCode).toBe(200)
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: caller === 'alice' ? ALICE : BOB,
    })
    const body = res.json()
    expect([res.statusCode, body.agents.length]).toEqual([200, 2])
    expect(body).toMatchObject({
      season_id: season.id,
      season_prompt: 'Rate the overall fun',
      read_only: false,
      agents: expect.arrayContaining([
        expect.objectContaining({
          agent: { kind: 'submission', submission_id: subId },
          display_name: label,
          author_prompt: 'Judge my dodging',
          your_rating: score,
          your_feedback: feedback,
          is_own: own,
        }),
        expect.objectContaining({
          agent: { kind: 'builtin', name: 'naive' },
          display_name: 'Naive agent',
          author_prompt: null,
          your_rating: null,
          your_feedback: null,
          is_own: false,
        }),
      ]),
    })
  })

  it('reveals submitted-agent names to admins and after public play closes', async () => {
    const { season, subId, sessionId } = await seedAliceSession('flappy_bird-names')
    await storage.updateSubmissionStatus(subId, 'ready')

    // The non-blind label resolves the owner's display name (never the opaque id), which an admin
    // sees even while play is open.
    const ownerLabel = "alice's agent"
    const operator = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: OPERATOR,
    })
    expect(operator.json()).toMatchObject({
      agents: [{ display_name: ownerLabel }],
    })

    await storage.setPlayStatus(season.id, 'closed')
    const regular = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })
    expect(regular.json()).toMatchObject({
      read_only: true,
      agents: [{ display_name: ownerLabel }],
    })
  })

  it('keeps distinct guest labels private and stable across routes and the play window', async () => {
    const { season, subId, recId } = await aliceRecording('flappy_bird-guest')
    const bobSub = await submissionFor(season.id, bobId)
    await storage.updateSubmissionStatus(subId, 'ready')
    await storage.updateSubmissionStatus(bobSub, 'ready')
    await writeRecording(recId, {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', label: "bob's agent", submission_id: bobSub },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })
    const headers = await users.headersFor('guest-user', { status: 'guest' })
    const viewer = await users.headersFor('viewer')
    const regular = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: viewer,
    })
    expect(regular.statusCode).toBe(200)
    const numberedLabels = regular
      .json<{ agents: Array<{ display_name: string }> }>()
      .agents.map((entry) => entry.display_name)
    expect(numberedLabels).toEqual([
      expect.stringMatching(/^Agent \d+$/),
      expect.stringMatching(/^Agent \d+$/),
    ])
    let original: Record<string, string> | undefined
    for (const play of ['open', 'closed'] as const) {
      await storage.setPlayStatus(season.id, play)
      for (const url of [
        `/api/sessions/${sessionId}/ratings`,
        `/api/recordings/${recId}/ratings`,
      ]) {
        const res = await app.inject({ method: 'GET', url, headers })
        const body = res.json<{
          read_only: boolean
          agents: Array<{
            agent: { submission_id: string }
            display_name: string
          }>
        }>()
        expect([res.statusCode, body.read_only]).toEqual([200, play === 'closed'])
        const labels = Object.fromEntries(
          body.agents.map((entry) => [entry.agent.submission_id, entry.display_name]),
        )
        expect(labels).toEqual({
          [subId]: expect.stringMatching(/^Agent \S+$/),
          [bobSub]: expect.stringMatching(/^Agent \S+$/),
        })
        expect(new Set(Object.values(labels)).size).toBe(2)
        for (const label of Object.values(labels)) expect(numberedLabels).not.toContain(label)
        expect(Object.values(labels).join(' ')).not.toMatch(/alice|bob/i)
        if (original === undefined) original = labels
        else expect(labels).toEqual(original)
      }
    }
  })

  it('offers no ratings and refuses writes for a pure Naive watch recording', async () => {
    const season = await playOpenSeason()
    const recId = await writeRecording('flappy_bird-naive-only', {
      player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    for (const url of [`/api/sessions/${sessionId}/ratings`, `/api/recordings/${recId}/ratings`]) {
      const read = await app.inject({ method: 'GET', url, headers: BOB })
      expect(read.statusCode).toBe(200)
      expect((read.json() as { agents: unknown[] }).agents).toEqual([])

      const write = await app.inject({
        method: 'POST',
        url,
        headers: BOB,
        payload: {
          ratings: [{ agent: { kind: 'builtin', name: 'naive' }, score: 5, feedback: 'steady' }],
        },
      })
      expect(write.statusCode).toBe(400)
      expect(write.json()).toMatchObject({ code: 'agent_not_in_session' })
    }
    expect(await storage.listRatingsBySeason(season.id)).toEqual([])
  })

  it('sets, replaces, and clears only the caller prompt while submissions are open', async () => {
    const season = await storage.createSeason({ env_id: ENV_ID, deps_version: 1 })
    await storage.setSubmissionStatus(season.id, 'open')
    await submissionFor(season.id, aliceId)
    await submissionFor(season.id, users.idOf('operator'))
    await storage.upsertAgentRatingPrompt(season.id, users.idOf('operator'), 'Other author')
    const url = `/api/seasons/${season.id}/agent-rating-prompt`
    for (const [prompt, expected] of [
      ['What to look for', 'What to look for'],
      ['Judge my dodging', 'Judge my dodging'],
      ['', null],
    ] as const) {
      const write = await app.inject({ method: 'PUT', url, headers: ALICE, payload: { prompt } })
      expect([write.statusCode, write.json()]).toEqual([
        200,
        { season_id: season.id, prompt: expected },
      ])
      const read = await app.inject({ method: 'GET', url, headers: ALICE })
      expect([read.statusCode, read.json()]).toEqual([
        200,
        { season_id: season.id, prompt: expected },
      ])
      const other = await app.inject({ method: 'GET', url, headers: OPERATOR })
      expect([other.statusCode, other.json()]).toEqual([
        200,
        { season_id: season.id, prompt: 'Other author' },
      ])
    }
    const denied = await app.inject({
      method: 'PUT',
      url,
      headers: BOB,
      payload: { prompt: 'nope' },
    })
    expect([denied.statusCode, denied.json().code]).toEqual([409, 'no_agent_in_season'])
    expect(await storage.getAgentRatingPrompt(season.id, bobId)).toBeUndefined()
  })

  it('preserves the saved prompt after submissions close even while play stays open', async () => {
    const season = await playOpenSeason()
    await submissionFor(season.id, aliceId)
    await storage.setSubmissionStatus(season.id, 'open')
    const url = `/api/seasons/${season.id}/agent-rating-prompt`
    const saved = await app.inject({
      method: 'PUT',
      url,
      headers: ALICE,
      payload: { prompt: 'Original prompt' },
    })
    expect(saved.statusCode).toBe(200)
    await storage.setSubmissionStatus(season.id, 'closed')
    const denied = await app.inject({
      method: 'PUT',
      url,
      headers: ALICE,
      payload: { prompt: 'too late' },
    })
    expect([denied.statusCode, denied.json().code]).toEqual([409, 'submissions_closed'])
    const read = await app.inject({ method: 'GET', url, headers: ALICE })
    expect([read.statusCode, read.json()]).toEqual([
      200,
      { season_id: season.id, prompt: 'Original prompt' },
    ])
    expect((await storage.getAgentRatingPrompt(season.id, aliceId))?.prompt).toBe('Original prompt')
  })

  describe('rating a replay', () => {
    it('rates a finished tournament game against its run season', async () => {
      const { season, subId, recId } = await aliceRecording('flappy_bird-t1')
      await tournamentGame(season.id, recId)

      const read = await app.inject({
        method: 'GET',
        url: `/api/recordings/${recId}/ratings`,
        headers: BOB,
      })
      expect(read.statusCode).toBe(200)
      expect(read.json()).toMatchObject({ season_id: season.id, read_only: false })

      const write = await app.inject({
        method: 'POST',
        url: `/api/recordings/${recId}/ratings`,
        headers: BOB,
        payload: {
          ratings: [
            { agent: { kind: 'submission', submission_id: subId }, score: 2, feedback: 'slow' },
          ],
        },
      })
      expect(write.statusCode).toBe(200)
      const stored = await storage.getRating(season.id, bobId, {
        kind: 'submission',
        submission_id: subId,
        user_id: aliceId,
      })
      expect(stored).toMatchObject({ score: 2, feedback: 'slow' })
    })

    it.each([
      { method: 'GET' as const, status: 'pending' as const },
      { method: 'GET' as const, status: 'running' as const },
      { method: 'POST' as const, status: 'pending' as const },
      { method: 'POST' as const, status: 'running' as const },
    ])('refuses a $method rating for a tournament game in $status state', async ({
      method,
      status,
    }) => {
      const { season, subId, recId } = await aliceRecording('flappy_bird-t2')
      await tournamentGame(season.id, recId, status)
      const res = await app.inject({
        method,
        url: `/api/recordings/${recId}/ratings`,
        headers: BOB,
        payload:
          method === 'POST'
            ? {
                ratings: [
                  {
                    agent: { kind: 'submission', submission_id: subId },
                    score: 5,
                    feedback: 'good game',
                  },
                ],
              }
            : undefined,
      })
      expect(res.statusCode).toBe(409)
      expect((res.json() as { code: string }).code).toBe('not_finished')
      expect(await storage.listRatingsBySeason(season.id)).toEqual([])
    })

    it('404s a missing recording and refuses one with no season', async () => {
      const missing = await app.inject({
        method: 'GET',
        url: '/api/recordings/flappy_bird-none/ratings',
        headers: BOB,
      })
      expect(missing.statusCode).toBe(404)
      expect((missing.json() as { code: string }).code).toBe('no_such_recording')

      const recId = await writeRecording('flappy_bird-t5', {
        player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      })
      const seasonless = await app.inject({
        method: 'GET',
        url: `/api/recordings/${recId}/ratings`,
        headers: BOB,
      })
      expect(seasonless.statusCode).toBe(409)
      expect((seasonless.json() as { code: string }).code).toBe('not_rateable')
    })

    it('masks a tournament replay stream for a non-operator while play is open', async () => {
      const season = await playOpenSeason()
      const subId = await submissionFor(season.id, aliceId)
      const recId = await writeRecording('flappy_bird-t6', {
        player_0: {
          kind: 'agent',
          label: "alice's agent",
          submission_id: subId,
          user: aliceId,
        },
      })
      await tournamentGame(season.id, recId)
      const label = async (headers: Record<string, string>): Promise<string> => {
        const res = await app.inject({ method: 'GET', url: `/api/recordings/${recId}`, headers })
        const header = JSON.parse(res.body.split('\n')[0] ?? '{}') as {
          players: Record<string, { label: string }>
        }
        return header.players.player_0?.label ?? ''
      }
      expect(await label(BOB)).toBe('Agent')
      expect(await label(OPERATOR)).toBe("alice's agent")
    })
  })
})
