import { maskedAgentLabel } from '@game-sandbox/schema/accounts'
import { render, screen } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import type { Board, Me } from '../src/api/client.js'
import { MeProvider } from '../src/me.js'
import { anonymousMe, signedInMe } from './helpers/me.js'

vi.mock('../src/api/client.js', () => ({
  // The factory is hoisted above imports, so it inlines the signed-in `/api/me` shape rather than
  // calling the shared helper (a runtime value, unavailable this early). The `Promise<Me>` annotation
  // type-checks the literal against the production shape so it cannot drift.
  getMe: vi.fn(async () => ({ user: null })),
}))

import { getMe } from '../src/api/client.js'
import LeaderboardBoards from '../src/components/LeaderboardBoards.vue'
import { memoryRouter } from './helpers/render.js'

const BOARD: Board = {
  automated: [
    {
      agent: {
        kind: 'submission',
        submission_id: 'sub-a',
        user_id: 'user-a',
        user_name: 'Ada Lovelace',
      },
      mean_score: 812.4,
      score_std: 31.2,
      mean_agent_compute_ms: 20,
      compute_std: 5,
      llm_usage_by_model: null,
      llm_weighted_cost: null,
      failure_count: 0,
      games: 3,
      recording_id: 'rec-a',
    },
  ],
  human: [],
  games: [],
}

function viewAs(me: Me) {
  vi.mocked(getMe).mockResolvedValue(me)
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
    { path: '/replays/:id', component: { template: '<div />' } },
  ])
  void router.push('/')
  return render(MeProvider, {
    slots: { default: () => h(LeaderboardBoards, { board: BOARD, envId: 'flappy_bird' }) },
    global: { plugins: [router] },
  })
}

describe('LeaderboardBoards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a signed-in viewer the owner display name', async () => {
    viewAs(signedInMe('viewer', 'normal'))
    const link = await screen.findByRole('link', { name: 'Ada Lovelace' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/agents/user-a')
    expect(link).toHaveAttribute('title', 'user-a')
  })

  it('shows a signed-out viewer the stable hash label and hides the id tooltip', async () => {
    viewAs(anonymousMe)
    const link = await screen.findByRole('link', { name: maskedAgentLabel('user-a') })
    // The profile link stays (URLs carry only the opaque id), but the raw-id tooltip is gone.
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/agents/user-a')
    expect(link).not.toHaveAttribute('title')
    expect(screen.queryByText('Ada Lovelace')).toBeNull()
  })
})
