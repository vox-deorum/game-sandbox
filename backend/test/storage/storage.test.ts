import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NewSessionInput, Storage } from '../../src/storage/index.js'
import { openSqliteStorage } from '../../src/storage/sqlite.js'
import { createRunOrFail } from '../support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from '../support/llm-options.js'

function input(overrides: Partial<NewSessionInput> = {}): NewSessionInput {
  return {
    id: 'sess-1',
    user_id: 'alice',
    env_id: 'flappy_bird',
    parameters: { players: 1 },
    mode: 'human',
    recording_id: 'flappy_bird-sess-1',
    created_at: '2026-06-11T00:00:00.000Z',
    ...overrides,
  }
}

describe('storage on :memory:', () => {
  let storage: Storage

  beforeEach(async () => {
    // The real implementation on an in-memory SQLite, schema and all.
    storage = await openSqliteStorage(':memory:')
  })

  afterEach(async () => {
    await storage.close()
  })

  it('creates a session in the starting state and reads it back', async () => {
    const created = await storage.createSession(input())
    expect(created).toMatchObject({
      id: 'sess-1',
      user_id: 'alice',
      env_id: 'flappy_bird',
      mode: 'human',
      status: 'starting',
      termination_reason: null,
      ended_at: null,
    })
    const fetched = await storage.getSession('sess-1')
    expect(fetched).toEqual(created)
  })

  it('persists the resolved human move budget and defaults it to null', async () => {
    // The move clock reads this back through getSession, so a session started with a custom human
    // timeout must round-trip it, and one started without carries null (the env-default case).
    await storage.createSession(input({ id: 'timed', human_timeout_ms: 5000 }))
    expect((await storage.getSession('timed'))?.human_timeout_ms).toBe(5000)

    await storage.createSession(input({ id: 'untimed' }))
    expect((await storage.getSession('untimed'))?.human_timeout_ms).toBeNull()
  })

  it('moves a session through running and ended', async () => {
    await storage.createSession(input())
    await storage.markRunning('sess-1')
    expect((await storage.getSession('sess-1'))?.status).toBe('running')

    await storage.markEnded('sess-1', 'terminated', '2026-06-11T00:01:00.000Z')
    const ended = await storage.getSession('sess-1')
    expect(ended?.status).toBe('ended')
    expect(ended?.termination_reason).toBe('terminated')
    expect(ended?.ended_at).toBe('2026-06-11T00:01:00.000Z')
  })

  it('finds a user active session while starting or running, but not once ended', async () => {
    await storage.createSession(input())
    expect(await storage.findActiveSessionByUser('alice')).toBeDefined()

    await storage.markRunning('sess-1')
    expect(await storage.findActiveSessionByUser('alice')).toBeDefined()

    await storage.markEnded('sess-1', 'stopped', '2026-06-11T00:02:00.000Z')
    expect(await storage.findActiveSessionByUser('alice')).toBeUndefined()
  })

  it('keeps users independent for the active-session lookup', async () => {
    await storage.createSession(input({ id: 'a', user_id: 'alice' }))
    await storage.createSession(input({ id: 'b', user_id: 'bob' }))
    expect((await storage.findActiveSessionByUser('alice'))?.id).toBe('a')
    expect((await storage.findActiveSessionByUser('bob'))?.id).toBe('b')
    expect(await storage.findActiveSessionByUser('carol')).toBeUndefined()
  })

  it('lists sessions most recent first', async () => {
    await storage.createSession(input({ id: 'a', created_at: '2026-06-11T00:00:00.000Z' }))
    await storage.createSession(input({ id: 'b', created_at: '2026-06-11T00:05:00.000Z' }))
    const ids = (await storage.listSessions()).map((s) => s.id)
    expect(ids).toEqual(['b', 'a'])
  })

  it('returns undefined for an unknown session', async () => {
    expect(await storage.getSession('nope')).toBeUndefined()
  })

  it('deletes an empty, fully private season and distinguishes a missing season', async () => {
    const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })

    expect(await storage.deleteSeason(season.id)).toEqual({ ok: true })
    expect(await storage.getSeason(season.id)).toBeUndefined()
    expect(await storage.deleteSeason(season.id)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('refuses to delete a season while a public gate is open or it is released', async () => {
    const submissionOpen = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
    await storage.setSubmissionStatus(submissionOpen.id, 'open')
    expect(await storage.deleteSeason(submissionOpen.id)).toEqual({
      ok: false,
      reason: 'season_not_deletable',
    })

    const playOpen = await storage.createSeason({ env_id: 'hearts', deps_version: 1 })
    await storage.setPlayStatus(playOpen.id, 'open')
    expect(await storage.deleteSeason(playOpen.id)).toEqual({
      ok: false,
      reason: 'season_not_deletable',
    })

    const released = await storage.createSeason({ env_id: 'spades', deps_version: 1 })
    await storage.setReleaseStatus(released.id, 'released')
    expect(await storage.deleteSeason(released.id)).toEqual({
      ok: false,
      reason: 'season_not_deletable',
    })
  })

  it('refuses to delete a season with any associated activity', async () => {
    const activity: ReadonlyArray<{ add: (seasonId: string) => Promise<void> }> = [
      {
        add: async (seasonId) => {
          await createRunOrFail(storage, seasonId, 'operator', () => ({
            parametersSnapshot: { players: 1 },
            scheduledGames: [
              { match_index: 0, game_index: 0, seed: 1, seats: [{ kind: 'builtin-naive' }] },
            ],
            llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
          }))
        },
      },
      {
        add: async (seasonId) => {
          await storage.createSubmission({
            season_id: seasonId,
            env_id: 'flappy_bird',
            user_id: `submitter-${seasonId}`,
            source_kind: 'git',
            repo_url: 'https://example.test/agent',
            commit_sha: 'c0ffee',
            local_path: null,
            ref: null,
            created_at: new Date().toISOString(),
          })
        },
      },
      {
        add: async (seasonId) => {
          await storage.createSession(
            input({ id: `session-${seasonId}`, season_id: seasonId, user_id: `user-${seasonId}` }),
          )
        },
      },
      {
        add: async (seasonId) => {
          await storage.upsertRating({
            season_id: seasonId,
            env_id: 'flappy_bird',
            rater_user_id: `rater-${seasonId}`,
            agent: { kind: 'builtin-naive' },
            score: 5,
          })
        },
      },
      {
        add: (seasonId) =>
          storage.upsertAgentRatingPrompt(seasonId, `author-${seasonId}`, 'Evaluate my strategy.'),
      },
      {
        add: (seasonId) => storage.setSeasonRatingPrompt(seasonId, 'Evaluate every agent fairly.'),
      },
      {
        add: (seasonId) =>
          storage
            .setSeasonDescription(seasonId, 'Read the Season instructions.')
            .then(() => undefined),
      },
      {
        add: (seasonId) =>
          storage
            .rotateDevelopmentKey({
              seasonId,
              userId: `developer-${seasonId}`,
              keyId: `key-${seasonId}`,
              secretHash: 'hash',
              now: new Date().toISOString(),
            })
            .then(() => undefined),
      },
    ]

    for (const { add } of activity) {
      const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
      await add(season.id)
      expect(await storage.deleteSeason(season.id)).toEqual({
        ok: false,
        reason: 'season_not_empty',
      })
      expect(await storage.getSeason(season.id)).toBeDefined()
    }
  })

  it('sets, replaces, and clears a Season description', async () => {
    const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1 })
    expect(season.description_markdown).toBeNull()

    const saved = await storage.setSeasonDescription(season.id, 'First description.')
    expect(saved?.description_markdown).toBe('First description.')
    const replaced = await storage.setSeasonDescription(season.id, 'Replacement description.')
    expect(replaced?.description_markdown).toBe('Replacement description.')
    const cleared = await storage.setSeasonDescription(season.id, null)
    expect(cleared?.description_markdown).toBeNull()
    expect(await storage.setSeasonDescription('missing', 'No row')).toBeUndefined()
  })
})
