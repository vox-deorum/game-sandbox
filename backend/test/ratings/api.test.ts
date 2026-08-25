/**
 * The participant rating API (Stage 6.6), Docker-free with `:memory:` storage and recordings written
 * straight to a temp volume. These prove the rateable-agent set is read from the finished recording
 * header, the own-agent owner is resolved server-side, the whole payload validates before any write,
 * and the three session gates (no season, no recording, closed play) reject as specified.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { maskedAgentLabel } from '@game-sandbox/schema/accounts'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { Retention } from '../../src/recordings/retention.js'
import { RecordingsStore } from '../../src/recordings/store.js'
import { Orchestrator } from '../../src/session/orchestrator.js'
import type { Season, Storage } from '../../src/storage/index.js'
import type { TestUsers } from '../support/auth.js'
import { FakeDriver } from '../support/fake-driver.js'
import {
  makeConfig,
  makeEnvironments,
  makeSubmissionDeps,
  openTestStack,
} from '../support/harness.js'

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
    const id = `sess-${Math.abs(hash(JSON.stringify(options)))}`
    await storage.createSession({
      id,
      user_id: 'bob',
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

  function hash(s: string): number {
    let h = 0
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i)
      h |= 0
    }
    return h
  }

  it('stores a rating of a submitted agent and a named builtin under the caller identity', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-a', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', builtin_name: 'cautious', label: 'Cautious bidder' },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 4, feedback: 'good dodge' },
          { agent: { kind: 'builtin', name: 'cautious' }, score: 5, feedback: 'steady' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)

    const submittedRating = await storage.getRating(season.id, bobId, {
      kind: 'submission',
      submission_id: subId,
      user_id: aliceId,
    })
    expect(submittedRating?.score).toBe(4)
    expect(submittedRating?.feedback).toBe('good dodge')
    // The write response round-trips the caller's comment back per agent.
    const body = res.json() as {
      agents: Array<{
        agent: { kind: string; submission_id?: string }
        your_feedback: string | null
      }>
    }
    expect(body.agents.find((a) => a.agent.kind === 'submission')).toMatchObject({
      your_feedback: 'good dodge',
    })
    const aggregate = await storage.aggregateRatingsByAgent(season.id)
    expect(aggregate.find((row) => row.agent.kind === 'builtin')).toEqual({
      agent: { kind: 'builtin', name: 'cautious' },
      mean: 5,
      std: 0,
      count: 1,
    })
  })

  it('overwrites a prior rating rather than duplicating while play is open', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-b', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })
    const agent = { kind: 'submission' as const, submission_id: subId }

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent, score: 2, feedback: 'first take' }] },
    })
    const second = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent, score: 5, feedback: 'revised take' }] },
    })
    expect(second.statusCode).toBe(200)
    expect(await storage.listRatingsBySeason(season.id)).toHaveLength(1)
    expect(
      (second.json() as { agents: Array<{ your_rating: number | null }> }).agents[0]?.your_rating,
    ).toBe(5)
    // The overwrite replaces both the score and the written comment.
    const [stored] = await storage.listRatingsBySeason(season.id)
    expect(stored?.feedback).toBe('revised take')
  })

  it('rejects a rating write from a pending (not-yet-active) user with not_active', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-not-allowed', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: await users.headersFor('mallory', { status: 'pending' }),
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 5, feedback: 'eager' },
        ],
      },
    })

    expect(res.statusCode).toBe(403)
    expect((res.json() as { code: string }).code).toBe('not_active')
    expect(await storage.listRatingsBySeason(season.id)).toHaveLength(0)
  })

  it('rejects a rating write and both rating reads for an anonymous caller', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-anon', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const write = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 5, feedback: 'anon' },
        ],
      },
    })
    expect(write.statusCode).toBe(401)
    expect((write.json() as { code: string }).code).toBe('auth_required')

    const read = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/ratings` })
    expect(read.statusCode).toBe(401)
    expect(await storage.listRatingsBySeason(season.id)).toHaveLength(0)
  })

  it('rejects an out-of-range score and a mixed valid/invalid payload writes nothing', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-c', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: 'fine' },
          { agent: { kind: 'submission', submission_id: subId }, score: 9, feedback: 'wrong' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code: string }).code).toBe('invalid_score')
    // The valid Naive score in the same payload was not written.
    expect(await storage.listRatingsBySeason(season.id)).toHaveLength(0)
  })

  it('requires a written comment within the code-point cap for every rating', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-comment', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    // Whitespace-only feedback is blank after trim, so the whole payload is rejected before any write.
    const blank = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [{ agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: '   ' }],
      },
    })
    expect(blank.statusCode).toBe(400)
    expect(blank.json()).toMatchObject({ code: 'empty_feedback' })

    const tooLong = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: 'x'.repeat(1_001) },
        ],
      },
    })
    expect(tooLong.statusCode).toBe(400)
    expect(tooLong.json()).toMatchObject({ code: 'feedback_too_long' })
    // Neither rejected comment was written.
    expect(await storage.listRatingsBySeason(season.id)).toHaveLength(0)

    // Exactly the cap in code points is accepted...
    const maxLength = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: 'x'.repeat(1_000) },
        ],
      },
    })
    expect(maxLength.statusCode).toBe(200)

    // ...and an emoji is one code point, so a thousand of them fit while a thousand and one do not.
    const emoji = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: '😀'.repeat(1_000) },
        ],
      },
    })
    expect(emoji.statusCode).toBe(200)
    const emojiTooLong = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          {
            agent: { kind: 'submission', submission_id: subId },
            score: 5,
            feedback: '😀'.repeat(1_001),
          },
        ],
      },
    })
    expect(emojiTooLong.statusCode).toBe(400)
    expect(emojiTooLong.json()).toMatchObject({ code: 'feedback_too_long' })
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

  it('rejects rating an agent that did not take part in the session', async () => {
    const season = await playOpenSeason()
    const recId = await writeRecording('flappy_bird-d', {
      player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: 'ghost' }, score: 3, feedback: 'who' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code: string }).code).toBe('agent_not_in_session')
  })

  it('rejects rating the caller own submitted agent, resolving the owner server-side', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-e', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    // Alice (the owner) rates her own agent; the wire form carries no owner, so the route must resolve
    // it from the submission and reject regardless of the body.
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: ALICE,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 5, feedback: 'me' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code: string }).code).toBe('own_agent')
    expect(await storage.listRatingsBySeason(season.id)).toHaveLength(0)
  })

  it('returns session_not_rateable for a null-season session', async () => {
    const recId = await writeRecording('flappy_bird-f', {
      player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ seasonId: null, recordingId: recId })
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { code: string }).code).toBe('session_not_rateable')
  })

  it('returns session_not_finished when no recording is on the volume', async () => {
    const season = await playOpenSeason()
    const sessionId = await seedSession({ seasonId: season.id, recordingId: null })
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [{ agent: { kind: 'builtin', name: 'naive' }, score: 4, feedback: 'shrug' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { code: string }).code).toBe('session_not_finished')
  })

  it('returns session_not_finished for a session that has not ended yet', async () => {
    const season = await playOpenSeason()
    const recId = await writeRecording('flappy_bird-run', {
      player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    // The recording header is on the volume, but the session is still running, not finalized.
    const sessionId = await seedSession({
      seasonId: season.id,
      recordingId: recId,
      ended: false,
    })
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { code: string }).code).toBe('session_not_finished')
  })

  it('rejects writes against a closed play window and marks reads read-only', async () => {
    // A submitted-agent watch session attaches to its submission's season; close play afterward.
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-g', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })
    await storage.setPlayStatus(season.id, 'closed')

    const write = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 3, feedback: 'late' },
        ],
      },
    })
    expect(write.statusCode).toBe(409)
    expect((write.json() as { code: string }).code).toBe('play_closed')

    const read = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })
    expect(read.statusCode).toBe(200)
    expect((read.json() as { read_only: boolean }).read_only).toBe(true)
  })

  it('reads effective ratings and both prompts per agent, Naive showing only the season prompt', async () => {
    const season = await playOpenSeason('Rate the overall fun')
    const subId = await submissionFor(season.id, aliceId)
    await storage.updateSubmissionStatus(subId, 'ready')
    await storage.upsertAgentRatingPrompt(season.id, aliceId, 'Judge my dodging')
    const recId = await writeRecording('flappy_bird-h', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
      player_2: { kind: 'human', label: 'bob', user: 'bob' },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    // Pre-rate the submitted agent so the read pre-fills the prior value and its written comment.
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 4, feedback: 'Bold dives' },
        ],
      },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      season_prompt: string | null
      read_only: boolean
      agents: Array<{
        agent: { kind: string; submission_id?: string }
        display_name: string
        is_own: boolean
        author_prompt: string | null
        your_rating: number | null
      }>
    }
    expect(body.season_prompt).toBe('Rate the overall fun')
    expect(body.read_only).toBe(false)
    // The human seat is skipped; the submitted agent and Naive remain.
    expect(body.agents).toHaveLength(2)
    const submitted = body.agents.find((a) => a.agent.kind === 'submission')
    expect(submitted).toMatchObject({
      display_name: 'Agent 1',
      author_prompt: 'Judge my dodging',
      your_rating: 4,
      your_feedback: 'Bold dives',
      is_own: false,
    })
    const naive = body.agents.find((a) => a.agent.kind === 'builtin')
    expect(naive).toMatchObject({
      display_name: 'Naive agent',
      author_prompt: null,
      your_rating: null,
      your_feedback: null,
    })
  })

  it('shows the user own submitted agent without offering a rating control', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    const recId = await writeRecording('flappy_bird-i', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: ALICE,
    })
    const body = res.json() as {
      agents: Array<{ display_name: string; is_own: boolean; your_rating: number | null }>
    }
    expect(body.agents[0]?.display_name).toBe('Your agent')
    expect(body.agents[0]?.is_own).toBe(true)
    expect(body.agents[0]?.your_rating).toBeNull()
  })

  it('reveals submitted-agent names to admins and after public play closes', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    await storage.updateSubmissionStatus(subId, 'ready')
    const recId = await writeRecording('flappy_bird-names', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

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

  it('shows a guest the stable hash label on every rating view, play window or not', async () => {
    const season = await playOpenSeason()
    const subId = await submissionFor(season.id, aliceId)
    await storage.updateSubmissionStatus(subId, 'ready')
    const recId = await writeRecording('flappy_bird-guest', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })
    const guestHeaders = await users.headersFor('guest-user', { status: 'guest' })

    // The hash label, not "Agent N", for a guest while play is open...
    const open = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: guestHeaders,
    })
    expect(open.json()).toMatchObject({
      read_only: false,
      agents: [{ display_name: maskedAgentLabel(aliceId) }],
    })

    // ...and identically once the window has closed (a guest is always masked).
    await storage.setPlayStatus(season.id, 'closed')
    const closed = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: guestHeaders,
    })
    expect(closed.json()).toMatchObject({
      read_only: true,
      agents: [{ display_name: maskedAgentLabel(aliceId) }],
    })
  })

  it('falls back to the stable owner id in a non-blind label when the user row is missing', async () => {
    const season = await playOpenSeason()
    // A submission attributed to an id with no user row (e.g. an imported roster).
    const subId = await submissionFor(season.id, 'ghost-user')
    const recId = await writeRecording('flappy_bird-ghost', {
      player_0: { kind: 'agent', label: "ghost-user's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const operator = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: OPERATOR,
    })
    expect(operator.json()).toMatchObject({
      agents: [{ display_name: "ghost-user's agent" }],
    })
  })

  it('returns no rateable agents for a pure Naive watch recording', async () => {
    const season = await playOpenSeason()
    const recId = await writeRecording('flappy_bird-naive-only', {
      player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ seasonId: season.id, recordingId: recId })

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { agents: unknown[] }).agents).toEqual([])
  })

  it('sets the author prompt under the caller identity and rejects a caller with no agent', async () => {
    const season = await playOpenSeason()
    await submissionFor(season.id, aliceId)
    await storage.setSubmissionStatus(season.id, 'open')

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/seasons/${season.id}/agent-rating-prompt`,
      headers: ALICE,
      payload: { prompt: 'What to look for' },
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { prompt: string | null }).prompt).toBe('What to look for')
    expect((await storage.getAgentRatingPrompt(season.id, aliceId))?.prompt).toBe(
      'What to look for',
    )

    const read = await app.inject({
      method: 'GET',
      url: `/api/seasons/${season.id}/agent-rating-prompt`,
      headers: ALICE,
    })
    expect((read.json() as { prompt: string | null }).prompt).toBe('What to look for')

    // Bob has no submission in this season.
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/seasons/${season.id}/agent-rating-prompt`,
      headers: BOB,
      payload: { prompt: 'nope' },
    })
    expect(denied.statusCode).toBe(409)
    expect((denied.json() as { code: string }).code).toBe('no_agent_in_season')
  })

  it('clears the author prompt when given an empty value', async () => {
    const season = await playOpenSeason()
    await submissionFor(season.id, aliceId)
    await storage.setSubmissionStatus(season.id, 'open')
    await app.inject({
      method: 'PUT',
      url: `/api/seasons/${season.id}/agent-rating-prompt`,
      headers: ALICE,
      payload: { prompt: 'something' },
    })
    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/seasons/${season.id}/agent-rating-prompt`,
      headers: ALICE,
      payload: { prompt: '' },
    })
    expect(cleared.statusCode).toBe(200)
    expect((cleared.json() as { prompt: string | null }).prompt).toBeNull()
  })

  it('locks the author prompt once the season submission window is closed', async () => {
    // Play is open and the author has an active submission, but submissions never opened — the
    // lifecycle forbids revisions once submissions close, even while play stays open, and a direct
    // API call must not bypass that to edit a prompt after submissions (or release).
    const season = await playOpenSeason()
    await submissionFor(season.id, aliceId)

    const denied = await app.inject({
      method: 'PUT',
      url: `/api/seasons/${season.id}/agent-rating-prompt`,
      headers: ALICE,
      payload: { prompt: 'too late' },
    })
    expect(denied.statusCode).toBe(409)
    expect((denied.json() as { code: string }).code).toBe('submissions_closed')
    expect(await storage.getAgentRatingPrompt(season.id, aliceId)).toBeUndefined()
  })
})
