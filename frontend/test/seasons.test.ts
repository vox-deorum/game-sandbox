import { render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { flappyMeta } from './helpers/fixtures.js'

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
  listPublicSeasons: vi.fn(),
}))

import { getEnvironments, listPublicSeasons } from '../src/api/client.js'
import SeasonsPage from '../src/pages/SeasonsPage.vue'

async function renderPage(): Promise<void> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/seasons', component: SeasonsPage },
      { path: '/environments/:envId', component: { template: '<div />' } },
      {
        path: '/environments/:envId/leaderboards/:seasonId?',
        component: { template: '<div />' },
      },
    ],
  })
  router.push('/seasons')
  await router.isReady()
  render(SeasonsPage, { global: { plugins: [router] } })
}

describe('SeasonsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
  })

  it('links play-open seasons to play and closed released seasons to their boards', async () => {
    vi.mocked(listPublicSeasons).mockResolvedValue([
      {
        id: 'live',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'released',
        label: 'Live round',
        created_at: '2026-06-11T00:00:00Z',
        released_at: '2026-06-12T00:00:00Z',
      },
      {
        id: 'history',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'closed',
        release_status: 'released',
        label: 'Past round',
        created_at: '2026-06-01T00:00:00Z',
        released_at: '2026-06-02T00:00:00Z',
      },
    ])

    await renderPage()

    expect(await screen.findByRole('link', { name: /Live round/ })).toHaveAttribute(
      'href',
      '/environments/flappy_bird?play=1',
    )
    expect(screen.getByRole('link', { name: /Past round/ })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards/history',
    )
  })
})
