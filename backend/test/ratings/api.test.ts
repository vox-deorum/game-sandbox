/**
 * The participant rating API (Stage 6.6), Docker-free with `:memory:` storage and recordings written
 * straight to a temp volume. These prove the rateable-agent set is read from the finished recording
 * header, the own-agent owner is resolved server-side, the whole payload validates before any write,
 * and the three session gates (no iteration, no recording, closed play) reject as specified.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
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
const BOB = { 'x-sandbox-user': 'bob' }
const ALICE = { 'x-sandbox-user': 'alice' }
const MALLORY = { 'x-sandbox-user': 'mallory' }

/** A header `players` entry as the recording schema shapes it. */
type PlayerEntry =
  | { kind: 'human'; label: string; user?: string }
  | { kind: 'agent'; label: string; submission_id?: string; user?: string }

describe('rating API', () => {
  let app: FastifyInstance
  let storage: Storage
  let orchestrator: Orchestrator
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gs-rate-'))
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
      allowlist: ['dev-user', 'alice', 'bob'],
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

  /** A play-open iteration (createIteration starts play-closed), with an optional operator prompt. */
  async function playOpenIteration(ratingPrompt?: string): Promise<Iteration> {
    const iteration = await storage.createIteration({ env_id: ENV_ID, deps_version: 1 })
    const opened = await storage.setPlayStatus(iteration.id, 'open')
    if (!opened.ok) {
      throw new Error('could not open play')
    }
    if (ratingPrompt !== undefined) {
      await storage.setIterationRatingPrompt(iteration.id, ratingPrompt)
    }
    return (await storage.getIteration(iteration.id)) as Iteration
  }

  /** Create a submission row for `userId` in the iteration; status is irrelevant to rating. */
  async function submissionFor(iterationId: string, userId: string): Promise<string> {
    const submission = await storage.createSubmission({
      iteration_id: iterationId,
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
    const header = { schema_version: 1, environment: ENV_ID, players }
    await writeFile(join(dir, id, 'recording.jsonl'), `${JSON.stringify(header)}\n`, 'utf-8')
    return id
  }

  /** Seed a session row with the given iteration and recording attribution; ended unless told otherwise. */
  async function seedSession(options: {
    starter?: string
    iterationId: string | null
    recordingId: string | null
    ended?: boolean
    submissionLinks?: Array<{ submissionId: string; slotId: string }>
  }): Promise<string> {
    const id = `sess-${Math.abs(hash(JSON.stringify(options)))}`
    await storage.createSession({
      id,
      user_id: options.starter ?? 'bob',
      env_id: ENV_ID,
      mode: 'scripted',
      recording_id: options.recordingId,
      iteration_id: options.iterationId,
      created_at: new Date().toISOString(),
    })
    if (options.ended !== false) {
      // A rateable session is a finished one; the rating gate requires the session to have ended.
      await storage.markEnded(id, 'terminated', new Date().toISOString())
    }
    for (const link of options.submissionLinks ?? []) {
      await storage.recordSessionSubmission(id, link.submissionId, link.slotId)
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

  it('stores a rating of a submitted agent and the Naive baseline under the caller identity', async () => {
    const iteration = await playOpenIteration()
    const subId = await submissionFor(iteration.id, 'alice')
    const recId = await writeRecording('flappy_bird-a', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'submission', submission_id: subId }, score: 4 },
          { agent: { kind: 'builtin-naive' }, score: 5 },
        ],
      },
    })
    expect(res.statusCode).toBe(200)

    const submittedRating = await storage.getRating(iteration.id, 'bob', {
      kind: 'submission',
      submission_id: subId,
      user_id: 'alice',
    })
    expect(submittedRating?.score).toBe(4)
    const aggregate = await storage.aggregateRatingsByAgent(iteration.id)
    expect(aggregate.find((row) => row.agent.kind === 'builtin-naive')).toEqual({
      agent: { kind: 'builtin-naive' },
      mean: 5,
      count: 1,
    })
  })

  it('overwrites a prior rating rather than duplicating while play is open', async () => {
    const iteration = await playOpenIteration()
    const subId = await submissionFor(iteration.id, 'alice')
    const recId = await writeRecording('flappy_bird-b', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })
    const agent = { kind: 'submission' as const, submission_id: subId }

    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent, score: 2 }] },
    })
    const second = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent, score: 5 }] },
    })
    expect(second.statusCode).toBe(200)
    expect(await storage.listRatingsByIteration(iteration.id)).toHaveLength(1)
    expect(
      (second.json() as { agents: Array<{ your_rating: number | null }> }).agents[0]?.your_rating,
    ).toBe(5)
  })

  it('rejects a rating write from a user outside the session allowlist', async () => {
    const iteration = await playOpenIteration()
    const subId = await submissionFor(iteration.id, 'alice')
    const recId = await writeRecording('flappy_bird-not-allowed', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: MALLORY,
      payload: {
        ratings: [{ agent: { kind: 'submission', submission_id: subId }, score: 5 }],
      },
    })

    expect(res.statusCode).toBe(403)
    expect((res.json() as { code: string }).code).toBe('not_allowlisted')
    expect(await storage.listRatingsByIteration(iteration.id)).toHaveLength(0)
  })

  it('rejects an out-of-range score and a mixed valid/invalid payload writes nothing', async () => {
    const iteration = await playOpenIteration()
    const subId = await submissionFor(iteration.id, 'alice')
    const recId = await writeRecording('flappy_bird-c', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: {
        ratings: [
          { agent: { kind: 'builtin-naive' }, score: 4 },
          { agent: { kind: 'submission', submission_id: subId }, score: 9 },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code: string }).code).toBe('invalid_score')
    // The valid Naive score in the same payload was not written.
    expect(await storage.listRatingsByIteration(iteration.id)).toHaveLength(0)
  })

  it('rejects rating an agent that did not take part in the session', async () => {
    const iteration = await playOpenIteration()
    const recId = await writeRecording('flappy_bird-d', {
      player_0: { kind: 'agent', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent: { kind: 'submission', submission_id: 'ghost' }, score: 3 }] },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code: string }).code).toBe('agent_not_in_session')
  })

  it('rejects rating the caller own submitted agent, resolving the owner server-side', async () => {
    const iteration = await playOpenIteration()
    const subId = await submissionFor(iteration.id, 'alice')
    const recId = await writeRecording('flappy_bird-e', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    // Alice (the owner) rates her own agent; the wire form carries no owner, so the route must resolve
    // it from the submission and reject regardless of the body.
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: ALICE,
      payload: { ratings: [{ agent: { kind: 'submission', submission_id: subId }, score: 5 }] },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { code: string }).code).toBe('own_agent')
    expect(await storage.listRatingsByIteration(iteration.id)).toHaveLength(0)
  })

  it('returns session_not_rateable for a null-iteration session', async () => {
    const recId = await writeRecording('flappy_bird-f', {
      player_0: { kind: 'agent', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ iterationId: null, recordingId: recId })
    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { code: string }).code).toBe('session_not_rateable')
  })

  it('returns session_not_finished when no recording is on the volume', async () => {
    const iteration = await playOpenIteration()
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: null })
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent: { kind: 'builtin-naive' }, score: 4 }] },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { code: string }).code).toBe('session_not_finished')
  })

  it('returns session_not_finished for a session that has not ended yet', async () => {
    const iteration = await playOpenIteration()
    const recId = await writeRecording('flappy_bird-run', {
      player_0: { kind: 'agent', label: 'Naive agent' },
    })
    // The recording header is on the volume, but the session is still running, not finalized.
    const sessionId = await seedSession({
      iterationId: iteration.id,
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
    // A submitted-agent watch session attaches to its submission's iteration; close play afterward.
    const iteration = await playOpenIteration()
    const subId = await submissionFor(iteration.id, 'alice')
    const recId = await writeRecording('flappy_bird-g', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })
    await storage.setPlayStatus(iteration.id, 'closed')

    const write = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent: { kind: 'submission', submission_id: subId }, score: 3 }] },
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

  it('reads effective ratings and both prompts per agent, Naive showing only the iteration prompt', async () => {
    const iteration = await playOpenIteration('Rate the overall fun')
    const subId = await submissionFor(iteration.id, 'alice')
    await storage.upsertAgentRatingPrompt(iteration.id, 'alice', 'Judge my dodging')
    const recId = await writeRecording('flappy_bird-h', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
      player_1: { kind: 'agent', label: 'Naive agent' },
      player_2: { kind: 'human', label: 'bob', user: 'bob' },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    // Pre-rate the submitted agent so the read pre-fills the prior value.
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
      payload: { ratings: [{ agent: { kind: 'submission', submission_id: subId }, score: 4 }] },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      iteration_prompt: string | null
      read_only: boolean
      agents: Array<{
        agent: { kind: string; submission_id?: string }
        is_own: boolean
        author_prompt: string | null
        your_rating: number | null
      }>
    }
    expect(body.iteration_prompt).toBe('Rate the overall fun')
    expect(body.read_only).toBe(false)
    // The human slot is skipped; the submitted agent and Naive remain.
    expect(body.agents).toHaveLength(2)
    const submitted = body.agents.find((a) => a.agent.kind === 'submission')
    expect(submitted).toMatchObject({
      author_prompt: 'Judge my dodging',
      your_rating: 4,
      is_own: false,
    })
    const naive = body.agents.find((a) => a.agent.kind === 'builtin-naive')
    expect(naive).toMatchObject({ author_prompt: null, your_rating: null })
  })

  it('shows the user own submitted agent without offering a rating control', async () => {
    const iteration = await playOpenIteration()
    const subId = await submissionFor(iteration.id, 'alice')
    const recId = await writeRecording('flappy_bird-i', {
      player_0: { kind: 'agent', label: "alice's agent", submission_id: subId },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: ALICE,
    })
    const body = res.json() as { agents: Array<{ is_own: boolean; your_rating: number | null }> }
    expect(body.agents[0]?.is_own).toBe(true)
    expect(body.agents[0]?.your_rating).toBeNull()
  })

  it('returns no rateable agents for a pure Naive watch recording', async () => {
    const iteration = await playOpenIteration()
    const recId = await writeRecording('flappy_bird-naive-only', {
      player_0: { kind: 'agent', label: 'Naive agent' },
    })
    const sessionId = await seedSession({ iterationId: iteration.id, recordingId: recId })

    const res = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/ratings`,
      headers: BOB,
    })

    expect(res.statusCode).toBe(200)
    expect((res.json() as { agents: unknown[] }).agents).toEqual([])
  })

  it('sets the author prompt under the caller identity and rejects a caller with no agent', async () => {
    const iteration = await playOpenIteration()
    await submissionFor(iteration.id, 'alice')

    const ok = await app.inject({
      method: 'PUT',
      url: `/api/iterations/${iteration.id}/agent-rating-prompt`,
      headers: ALICE,
      payload: { prompt: 'What to look for' },
    })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { prompt: string | null }).prompt).toBe('What to look for')
    expect((await storage.getAgentRatingPrompt(iteration.id, 'alice'))?.prompt).toBe(
      'What to look for',
    )

    const read = await app.inject({
      method: 'GET',
      url: `/api/iterations/${iteration.id}/agent-rating-prompt`,
      headers: ALICE,
    })
    expect((read.json() as { prompt: string | null }).prompt).toBe('What to look for')

    // Bob has no submission in this iteration.
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/iterations/${iteration.id}/agent-rating-prompt`,
      headers: BOB,
      payload: { prompt: 'nope' },
    })
    expect(denied.statusCode).toBe(409)
    expect((denied.json() as { code: string }).code).toBe('no_agent_in_iteration')
  })

  it('clears the author prompt when given an empty value', async () => {
    const iteration = await playOpenIteration()
    await submissionFor(iteration.id, 'alice')
    await app.inject({
      method: 'PUT',
      url: `/api/iterations/${iteration.id}/agent-rating-prompt`,
      headers: ALICE,
      payload: { prompt: 'something' },
    })
    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/iterations/${iteration.id}/agent-rating-prompt`,
      headers: ALICE,
      payload: { prompt: '' },
    })
    expect(cleared.statusCode).toBe(200)
    expect((cleared.json() as { prompt: string | null }).prompt).toBeNull()
  })
})
