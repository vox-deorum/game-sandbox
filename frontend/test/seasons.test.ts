import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublicSeasonView } from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
  getMe: vi.fn(),
  listPublicSeasons: vi.fn(),
}))

vi.mock('../src/renderers/registry.js', () => ({
  thumbnailFor: vi.fn(() => '/assets/flappy-thumb.svg'),
}))

import { getEnvironments, getMe, listPublicSeasons } from '../src/api/client.js'
import SeasonsPage from '../src/pages/SeasonsPage.vue'
import { thumbnailFor } from '../src/renderers/registry.js'

function season(overrides: Partial<PublicSeasonView> = {}): PublicSeasonView {
  return {
    id: 'season-1',
    env_id: 'flappy_bird',
    submission_status: 'closed',
    play_status: 'closed',
    release_status: 'unreleased',
    label: 'Season',
    created_at: '2026-06-11T00:00:00Z',
    released_at: null,
    submission_count: 0,
    session_count: 0,
    ...overrides,
  }
}

async function renderPage() {
  const router = memoryRouter([
    { path: '/seasons', component: SeasonsPage },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
    {
      path: '/environments/:envId/leaderboards/:seasonId?',
      component: { template: '<div />' },
    },
  ])
  await router.push('/seasons')
  await router.isReady()
  return renderWithMe(router)
}

describe('SeasonsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'alice',
      allowlisted: true,
      is_operator: false,
    })
  })

  it('renders active gate actions, the thumbnail, and the complete metadata line', async () => {
    vi.mocked(listPublicSeasons).mockResolvedValue([
      season({
        id: 'released',
        label: 'Released round',
        submission_status: 'open',
        play_status: 'open',
        release_status: 'released',
        released_at: '2026-06-12T00:00:00Z',
        submission_count: 3,
        session_count: 8,
      }),
    ])

    const { container } = await renderPage()
    const row = (await screen.findByText('Released round')).closest('li')
    expect(row).not.toBeNull()
    const card = within(row as HTMLElement)

    expect(card.getByRole('link', { name: 'Open Released round' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards/released',
    )
    expect(card.getByRole('link', { name: 'Submissions open' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/agents/alice',
    )
    expect(card.getByRole('link', { name: 'Play open' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird?play=1',
    )
    expect(card.getByRole('link', { name: 'Results released' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards/released',
    )
    expect(card.queryByText('Open now')).not.toBeInTheDocument()
    expect(card.getByText(/Released at .*2026.* · 3 Submissions · 8 Sessions Played/)).toBeVisible()

    const thumbnail = container.querySelector<HTMLImageElement>('.season-thumb')
    expect(thumbnail).toHaveAttribute('src', '/assets/flappy-thumb.svg')
    expect(thumbnailFor).toHaveBeenCalledWith('flappy-bird')
  })

  it('uses released, submission, then play priority and omits inactive gate tags', async () => {
    vi.mocked(listPublicSeasons).mockResolvedValue([
      season({
        id: 'released',
        label: 'Released round',
        submission_status: 'open',
        play_status: 'open',
        release_status: 'released',
        released_at: '2026-06-12T00:00:00Z',
      }),
      season({
        id: 'submit',
        label: 'Submit round',
        submission_status: 'open',
        submission_count: 2,
      }),
      season({
        id: 'play',
        label: 'Play round',
        play_status: 'open',
        session_count: 4,
      }),
    ])

    await renderPage()

    expect(await screen.findByRole('link', { name: 'Open Released round' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards/released',
    )
    expect(screen.getByRole('link', { name: 'Open Submit round' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/agents/alice',
    )
    expect(screen.getByRole('link', { name: 'Open Play round' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird?play=1',
    )

    const submitRow = screen.getByText('Submit round').closest('li')
    expect(submitRow).not.toBeNull()
    const submitCard = within(submitRow as HTMLElement)
    expect(submitCard.getByRole('link', { name: 'Submissions open' })).toBeVisible()
    expect(submitCard.queryByText('Play open')).not.toBeInTheDocument()
    expect(submitCard.queryByText('Results released')).not.toBeInTheDocument()
    expect(submitCard.getByText('2 Submissions · 0 Sessions Played')).toBeVisible()
    expect(submitCard.queryByText(/Released at/)).not.toBeInTheDocument()

    const playRow = screen.getByText('Play round').closest('li')
    expect(playRow).not.toBeNull()
    const playCard = within(playRow as HTMLElement)
    expect(playCard.getByRole('link', { name: 'Play open' })).toBeVisible()
    expect(playCard.queryByText('Submissions open')).not.toBeInTheDocument()
    expect(playCard.queryByText('Results released')).not.toBeInTheDocument()
  })
})
