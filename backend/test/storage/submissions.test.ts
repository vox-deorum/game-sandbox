import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { seedOpenSeasons } from '../../src/seasons-seed.js'
import {
  decodeSeasonConfig,
  type NewSessionInput,
  type NewSubmissionInput,
  type Storage,
} from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { makeEnvironments } from '../support/harness.js'

/** A pending git submission input, overridable. The season id is filled per test. */
function subInput(overrides: Partial<NewSubmissionInput> = {}): NewSubmissionInput {
  return {
    season_id: 'iter-1',
    env_id: 'flappy_bird',
    user_id: 'alice',
    source_kind: 'git',
    repo_url: 'https://example.com/alice/agent.git',
    commit_sha: null,
    local_path: null,
    ref: null,
    created_at: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

function sessionInput(overrides: Partial<NewSessionInput> = {}): NewSessionInput {
  return {
    id: 'sess-1',
    user_id: 'alice',
    env_id: 'flappy_bird',
    mode: 'scripted',
    recording_id: 'flappy_bird-sess-1',
    created_at: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('submission storage on :memory:', () => {
  let storage: Storage

  beforeEach(async () => {
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
  })

  async function seasonId(envId = 'flappy_bird'): Promise<string> {
    const iter = await storage.ensureOpenSeason(envId, 1)
    return iter.id
  }

  it('ensureOpenSeason is idempotent for an environment', async () => {
    const first = await storage.ensureOpenSeason('flappy_bird', 1)
    const second = await storage.ensureOpenSeason('flappy_bird', 2)
    expect(second.id).toBe(first.id)
    expect(first.submission_status).toBe('open')
    // The pinned deps version now lives inside the validated config document.
    expect(decodeSeasonConfig(first.config).deps_version).toBe(1)
    expect(decodeSeasonConfig(second.config).deps_version).toBe(1)
    expect((await storage.getOpenSubmissionSeason('flappy_bird'))?.id).toBe(first.id)
  })

  it('createSubmission inserts a pending row and supersedes a same-user resubmit', async () => {
    const iter = await seasonId()
    const first = await storage.createSubmission(
      subInput({ season_id: iter, created_at: '2026-06-11T00:00:00.000Z' }),
    )
    expect(first.status).toBe('pending')
    expect(first.superseded_at).toBeNull()
    expect(first.commit_sha).toBeNull()

    const second = await storage.createSubmission(
      subInput({ season_id: iter, created_at: '2026-06-11T00:05:00.000Z' }),
    )
    // The active lookup returns only the new row; history keeps both.
    const active = await storage.findActiveSubmission(iter, 'alice')
    expect(active?.id).toBe(second.id)
    const history = await storage.listSubmissionsByUser('alice')
    expect(history.map((s) => s.id).sort()).toEqual([first.id, second.id].sort())
    const supersededFirst = await storage.getSubmission(first.id)
    expect(supersededFirst?.superseded_at).toBe('2026-06-11T00:05:00.000Z')
  })

  it('does not supersede a different user in the same season', async () => {
    const iter = await seasonId()
    const alice = await storage.createSubmission(subInput({ season_id: iter, user_id: 'alice' }))
    const bob = await storage.createSubmission(subInput({ season_id: iter, user_id: 'bob' }))
    expect((await storage.findActiveSubmission(iter, 'alice'))?.id).toBe(alice.id)
    expect((await storage.findActiveSubmission(iter, 'bob'))?.id).toBe(bob.id)
    expect((await storage.getSubmission(alice.id))?.superseded_at).toBeNull()
  })

  it('keeps exactly one active row when two submits race for the same participant', async () => {
    const iter = await seasonId()
    await Promise.all([
      storage.createSubmission(
        subInput({ season_id: iter, created_at: '2026-06-11T00:00:00.000Z' }),
      ),
      storage.createSubmission(
        subInput({ season_id: iter, created_at: '2026-06-11T00:00:01.000Z' }),
      ),
    ])
    const active = await storage.listActiveSubmissionsBySeason(iter)
    expect(active.filter((s) => s.user_id === 'alice')).toHaveLength(1)
    // Both attempts are preserved as history regardless of which won the active slot.
    expect(await storage.listSubmissionsByUser('alice')).toHaveLength(2)
  })

  it('updateSubmissionPin records the commit for git and leaves local commitless', async () => {
    const iter = await seasonId()
    const git = await storage.createSubmission(subInput({ season_id: iter, user_id: 'alice' }))
    const local = await storage.createSubmission(
      subInput({
        season_id: iter,
        user_id: 'bob',
        source_kind: 'local',
        repo_url: null,
        local_path: '/srv/examples/flappy',
      }),
    )
    await storage.updateSubmissionPin(git.id, 'abc1234')
    await storage.updateSubmissionPin(local.id, 'def5678')
    expect((await storage.getSubmission(git.id))?.commit_sha).toBe('abc1234')
    expect((await storage.getSubmission(local.id))?.commit_sha).toBeNull()
  })

  it('updateSubmissionStatus records failure reasons and clears reason on ready', async () => {
    const iter = await seasonId()
    const sub = await storage.createSubmission(subInput({ season_id: iter }))
    await storage.updateSubmissionStatus(sub.id, 'static_failed', 'manifest_missing')
    let row = await storage.getSubmission(sub.id)
    expect(row?.status).toBe('static_failed')
    expect(row?.reason).toBe('manifest_missing')

    await storage.updateSubmissionStatus(sub.id, 'ready')
    row = await storage.getSubmission(sub.id)
    expect(row?.status).toBe('ready')
    expect(row?.reason).toBeNull()
  })

  it('records and overwrites per-stage checks and lists them in pipeline order', async () => {
    const iter = await seasonId()
    const sub = await storage.createSubmission(subInput({ season_id: iter }))

    await storage.startSubmissionCheck(sub.id, 'resolve')
    await storage.finishSubmissionCheck(sub.id, 'resolve', 'passed')
    await storage.startSubmissionCheck(sub.id, 'static')
    await storage.finishSubmissionCheck(sub.id, 'static', 'failed', 'manifest_missing')

    let checks = await storage.listSubmissionChecks(sub.id)
    expect(checks.map((c) => c.stage)).toEqual(['resolve', 'static'])
    expect(checks[0]?.status).toBe('passed')
    expect(checks[1]).toMatchObject({ status: 'failed', detail: 'manifest_missing' })
    expect(checks[1]?.ended_at).not.toBeNull()

    // A re-enqueue restarts the stage: the prior check is overwritten, not duplicated.
    await storage.startSubmissionCheck(sub.id, 'static')
    checks = await storage.listSubmissionChecks(sub.id)
    expect(checks.filter((c) => c.stage === 'static')).toHaveLength(1)
    expect(checks.find((c) => c.stage === 'static')).toMatchObject({
      status: 'running',
      detail: null,
      ended_at: null,
    })
  })

  it('listSubmissionChecks orders all four stages by pipeline sequence', async () => {
    const iter = await seasonId()
    const sub = await storage.createSubmission(subInput({ season_id: iter }))
    // Write them out of order to prove the read sorts, not the insertion order.
    for (const stage of ['load', 'build', 'static', 'resolve'] as const) {
      await storage.startSubmissionCheck(sub.id, stage)
    }
    const checks = await storage.listSubmissionChecks(sub.id)
    expect(checks.map((c) => c.stage)).toEqual(['resolve', 'static', 'build', 'load'])
  })

  it('listPendingSubmissions returns active pending rows newest-first and skips superseded', async () => {
    const iter = await seasonId()
    const older = await storage.createSubmission(
      subInput({ season_id: iter, user_id: 'alice', created_at: '2026-06-11T00:00:00.000Z' }),
    )
    // Supersede alice's older submission with a newer one.
    const newer = await storage.createSubmission(
      subInput({ season_id: iter, user_id: 'alice', created_at: '2026-06-11T00:09:00.000Z' }),
    )
    const bob = await storage.createSubmission(
      subInput({ season_id: iter, user_id: 'bob', created_at: '2026-06-11T00:03:00.000Z' }),
    )
    const pending = await storage.listPendingSubmissions()
    expect(pending.map((s) => s.id)).toEqual([newer.id, bob.id])
    expect(pending.map((s) => s.id)).not.toContain(older.id)
  })

  it('listActiveSubmissionsBySeason filters superseded and narrows by status', async () => {
    const iter = await seasonId()
    const alice = await storage.createSubmission(subInput({ season_id: iter, user_id: 'alice' }))
    await storage.updateSubmissionStatus(alice.id, 'ready')
    const bob = await storage.createSubmission(subInput({ season_id: iter, user_id: 'bob' }))
    await storage.updateSubmissionStatus(bob.id, 'static_failed', 'manifest_missing')

    const all = await storage.listActiveSubmissionsBySeason(iter)
    expect(all.map((s) => s.id).sort()).toEqual([alice.id, bob.id].sort())
    const ready = await storage.listActiveSubmissionsBySeason(iter, 'ready')
    expect(ready.map((s) => s.id)).toEqual([alice.id])
  })

  it('listActiveReadySubmissionIds returns only active ready ids across seasons', async () => {
    const flappyIter = await seasonId('flappy_bird')
    const otherIter = await seasonId('turn_based')

    const ready = await storage.createSubmission(
      subInput({ season_id: flappyIter, user_id: 'alice' }),
    )
    await storage.updateSubmissionStatus(ready.id, 'ready')
    // A ready submission in another season is also included.
    const otherReady = await storage.createSubmission(
      subInput({ season_id: otherIter, env_id: 'turn_based', user_id: 'carol' }),
    )
    await storage.updateSubmissionStatus(otherReady.id, 'ready')
    // A failed submission is excluded.
    const failed = await storage.createSubmission(
      subInput({ season_id: flappyIter, user_id: 'bob' }),
    )
    await storage.updateSubmissionStatus(failed.id, 'load_failed', 'class_not_found')
    // A superseded-but-ready submission is excluded.
    await storage.updateSubmissionStatus(ready.id, 'ready')
    const supersede = await storage.createSubmission(
      subInput({
        season_id: flappyIter,
        user_id: 'alice',
        created_at: '2026-06-11T01:00:00.000Z',
      }),
    )
    await storage.updateSubmissionStatus(supersede.id, 'ready')

    const ids = (await storage.listActiveReadySubmissionIds()).sort()
    expect(ids).toEqual([otherReady.id, supersede.id].sort())
  })

  it('links sessions to submissions and lists their recordings newest-first', async () => {
    const iter = await seasonId()
    const sub = await storage.createSubmission(subInput({ season_id: iter }))

    await storage.createSession(
      sessionInput({
        id: 'sess-old',
        recording_id: 'rec-old',
        created_at: '2026-06-11T00:00:00.000Z',
      }),
    )
    await storage.createSession(
      sessionInput({
        id: 'sess-new',
        recording_id: 'rec-new',
        created_at: '2026-06-11T00:05:00.000Z',
      }),
    )
    // A session with no recording is ignored by the listing.
    await storage.createSession(
      sessionInput({ id: 'sess-none', recording_id: null, created_at: '2026-06-11T00:06:00.000Z' }),
    )
    await storage.recordSessionSubmission('sess-old', sub.id, 'player_0')
    await storage.recordSessionSubmission('sess-new', sub.id, 'player_0')
    await storage.recordSessionSubmission('sess-none', sub.id, 'player_0')
    await storage.createRecording({
      id: 'rec-old',
      user_id: 'alice',
      env_id: 'flappy_bird',
      created_at: '2026-06-11T00:00:00.000Z',
    })
    await storage.createRecording({
      id: 'rec-new',
      user_id: 'alice',
      env_id: 'flappy_bird',
      created_at: '2026-06-11T00:05:00.000Z',
    })

    const recordings = await storage.listRecordingsBySubmission(sub.id, 10)
    expect(recordings).toEqual(['rec-new', 'rec-old'])
  })
})

describe('schema and seed idempotency on a file database', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gs-subs-'))
    dbPath = join(dir, 'sandbox.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the schema once and is a no-op on reopen, seeding one season per env', async () => {
    const environments = makeEnvironments()
    const expectedEnvCount = environments.list().length

    const first = await openSqliteStorage(dbPath)
    await seedOpenSeasons(first, environments, 1)
    const afterFirst = await Promise.all(
      environments.list().map((m) => first.getOpenSubmissionSeason(m.env_id)),
    )
    expect(
      afterFirst.every(
        (it) =>
          it?.submission_status === 'open' && decodeSeasonConfig(it.config).deps_version === 1,
      ),
    ).toBe(true)
    const firstIds = afterFirst.map((it) => it?.id)
    await first.close()

    // Reopen the same file: schema setup re-runs as a no-op and the seed leaves seasons untouched.
    const second = await openSqliteStorage(dbPath)
    await seedOpenSeasons(second, environments, 1)
    const afterSecond = await Promise.all(
      environments.list().map((m) => second.getOpenSubmissionSeason(m.env_id)),
    )
    expect(afterSecond.map((it) => it?.id)).toEqual(firstIds)
    expect(afterSecond).toHaveLength(expectedEnvCount)
    await second.close()
  })
})
