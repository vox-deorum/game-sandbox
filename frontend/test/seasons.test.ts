import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PublicSeasonView } from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
  getMe: vi.fn(),
  listSeasons: vi.fn(),
}))

vi.mock('../src/renderers/registry.js', () => ({
  thumbnailFor: vi.fn(() => '/assets/flappy-thumb.svg'),
}))

import { getEnvironments, getMe, listSeasons } from '../src/api/client.js'
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
    description_markdown: null,
    created_at: '2026-06-11T00:00:00Z',
    released_at: null,
    submission_count: 0,
    game_count: 0,
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
    { path: '/login', component: { template: '<div />' } },
  ])
  await router.push('/seasons')
  await router.isReady()
  return renderWithMe(router)
}

describe('SeasonsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
    vi.mocked(getMe).mockResolvedValue(signedInMe('alice', 'normal'))
  })

  it('renders active gate actions, the thumbnail, and the complete metadata line', async () => {
    vi.mocked(listSeasons).mockResolvedValue([
      season({
        id: 'released',
        label: 'Released round',
        submission_status: 'open',
        play_status: 'open',
        release_status: 'released',
        released_at: '2026-06-12T00:00:00Z',
        submission_count: 3,
        game_count: 12,
      }),
    ])

    const { container } = await renderPage()
    const row = (await screen.findByText('Released round')).closest('li')
    expect(row).not.toBeNull()
    const card = within(row as HTMLElement)

    expect(card.getByRole('link', { name: 'Open season Released round' })).toHaveAttribute(
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
    expect(card.getByText(/Released at .*2026.* · 3 Submissions · 12 Games/)).toBeVisible()

    const thumbnail = container.querySelector<HTMLImageElement>('.season-thumb')
    expect(thumbnail).toHaveAttribute('src', '/assets/flappy-thumb.svg')
    expect(thumbnailFor).toHaveBeenCalledWith('flappy-bird')
  })

  it('uses released, submission, then play priority and omits inactive gate tags', async () => {
    vi.mocked(listSeasons).mockResolvedValue([
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
      }),
    ])

    await renderPage()

    expect(await screen.findByRole('link', { name: 'Open season Released round' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards/released',
    )
    expect(screen.getByRole('link', { name: 'Open season Submit round' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/agents/alice',
    )
    expect(screen.getByRole('link', { name: 'Open season Play round' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird?play=1',
    )

    const submitRow = screen.getByText('Submit round').closest('li')
    expect(submitRow).not.toBeNull()
    const submitCard = within(submitRow as HTMLElement)
    expect(submitCard.getByRole('link', { name: 'Submissions open' })).toBeVisible()
    expect(submitCard.queryByText('Play open')).not.toBeInTheDocument()
    expect(submitCard.queryByText('Results released')).not.toBeInTheDocument()
    expect(submitCard.getByText('2 Submissions · 0 Games')).toBeVisible()
    expect(submitCard.queryByText(/Released at/)).not.toBeInTheDocument()

    const playRow = screen.getByText('Play round').closest('li')
    expect(playRow).not.toBeNull()
    const playCard = within(playRow as HTMLElement)
    expect(playCard.getByRole('link', { name: 'Play open' })).toBeVisible()
    expect(playCard.queryByText('Submissions open')).not.toBeInTheDocument()
    expect(playCard.queryByText('Results released')).not.toBeInTheDocument()
  })

  it('omits absent descriptions and renders a supplied description above the environment metadata', async () => {
    vi.mocked(listSeasons).mockResolvedValue([
      season({ id: 'without', label: 'No description' }),
      season({
        id: 'with',
        label: 'With description',
        submission_status: 'open',
        description_markdown:
          'Try **careful** [timing notes](https://example.test/notes) at `60 FPS`.',
      }),
    ])

    await renderPage()
    await screen.findByText('No description')

    const without = screen.getByText('No description').closest('li') as HTMLElement
    expect(without.querySelector('.season-description')).toBeNull()
    const withDescription = screen.getByText('With description').closest('li') as HTMLElement
    const description = withDescription.querySelector('.season-description') as HTMLElement
    const environment = withDescription.querySelector('.season-env')
    expect(environment).not.toBeNull()
    expect(description).toHaveTextContent('Try careful timing notes at 60 FPS.')
    expect(description.innerHTML).toContain('<strong>careful</strong>')
    const descriptionLink = description.querySelector('a') as HTMLAnchorElement
    expect(descriptionLink).toHaveAttribute('href', 'https://example.test/notes')
    expect(descriptionLink).toHaveAttribute('target', '_blank')
    expect(descriptionLink).toHaveAttribute('rel', 'noopener noreferrer')
    expect(withDescription.querySelector('.season-card-link')).toHaveAttribute(
      'aria-label',
      'Open season With description',
    )
    expect(
      description.compareDocumentPosition(environment as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
  it('points the submission action at sign-in for an anonymous visitor', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    vi.mocked(listSeasons).mockResolvedValue([
      season({
        id: 'submit',
        label: 'Submit round',
        submission_status: 'open',
        submission_count: 2,
      }),
    ])

    await renderPage()

    // With no agent profile of their own, the "Submissions open" action routes to the login page.
    expect(await screen.findByRole('link', { name: 'Submissions open' })).toHaveAttribute(
      'href',
      '/login',
    )
    expect(screen.getByRole('link', { name: 'Open season Submit round' })).toHaveAttribute(
      'href',
      '/login',
    )
  })
})
