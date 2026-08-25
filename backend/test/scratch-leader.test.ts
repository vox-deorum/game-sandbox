import { expect, it } from 'vitest'
import { openTestApp } from './support/harness.js'
import { createRunOrFail } from './support/harness.js'
import { TEST_DISABLED_OFFICIAL_LLM_POLICY } from './support/llm-options.js'

it('debug leaderboard 500', async () => {
  const fixture = await openTestApp()
  const { app, storage } = fixture
  try {
    const season = await storage.createSeason({ env_id: 'flappy_bird', deps_version: 1, label: null })
    await storage.setReleaseStatus(season.id, 'released')
    const naive = { kind: 'builtin', name: 'naive' } as const
    await createRunOrFail(storage, season.id, 'dev-user', () => ({
      parametersSnapshot: { players: 1 },
      scheduledGames: [{ match_index: 0, game_index: 0, seed: 1, seats: [naive], seat_plan: 'solo' }],
      llmPolicy: TEST_DISABLED_OFFICIAL_LLM_POLICY,
    }))
    const res = await app.inject({ method: 'GET', url: '/api/environments/flappy_bird/leaderboards' })
    console.log('STATUS', res.statusCode)
    console.log('BODY', res.body.slice(0, 600))
    expect(res.statusCode).toBe(200)
  } finally {
    await fixture.close()
  }
})
