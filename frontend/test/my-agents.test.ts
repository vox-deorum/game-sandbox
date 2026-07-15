import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MyAgentEnvironmentSummary } from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getMyAgents: vi.fn(),
}))

vi.mock('../src/environmentCatalog.js', () => ({
  loadEnvironmentCatalog: vi.fn(),
  resetEnvironmentCatalog: vi.fn(),
}))

import { getMe, getMyAgents } from '../src/api/client.js'
import { loadEnvironmentCatalog } from '../src/environmentCatalog.js'
import MyAgentsPage from '../src/pages/MyAgentsPage.vue'

async function renderPage() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
    { path: '/my/agents', component: MyAgentsPage },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
  ])
  router.push('/my/agents')
  await router.isReady()
  return renderWithMe(router)
}

function season(
  id: string,
  overrides: Partial<NonNullable<MyAgentEnvironmentSummary['current_season']>> = {},
) {
  return {
    id,
    label: `Season ${id}`,
    created_at: '2026-06-01T00:00:00Z',
    release_status: 'released' as const,
    submission: {
      id: `submission-${id}`,
      status: 'ready' as const,
      submitted_at: '2026-06-02T00:00:00Z',
    },
    mean_score: 10,
    ...overrides,
  }
}

describe('MyAgentsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('student-1'))
    vi.mocked(loadEnvironmentCatalog).mockResolvedValue([
      flappyMeta({ env_id: 'flappy_bird', display_name: 'Flappy Bird' }),
      flappyMeta({ env_id: 'hearts', display_name: 'Hearts' }),
    ])
  })

  it('shows current submission state and links the whole season card to My Submissions', async () => {
    vi.mocked(getMyAgents).mockResolvedValue([
      {
        env_id: 'flappy_bird',
        current_season: season('week-4', {
          label: 'Week 4',
          release_status: 'unreleased',
          submission: {
            id: 'submission-current',
            status: 'pending',
            submitted_at: '2026-06-14T00:00:00Z',
          },
          mean_score: null,
        }),
        previous_seasons: [],
      },
      {
        env_id: 'hearts',
        current_season: season('week-2', {
          label: null,
          release_status: 'unreleased',
          submission: null,
          mean_score: null,
        }),
        previous_seasons: [],
      },
    ])

    await renderPage()

    const flappyLink = await screen.findByRole('link', {
      name: /Week 4 pending Submitted .* Results not released/,
    })
    expect(flappyLink).toHaveAttribute(
      'href',
      '/environments/flappy_bird/agents/student-1?season=week-4',
    )
    expect(within(flappyLink).getByText(/Submitted/)).toBeInTheDocument()
    expect(within(flappyLink).getByText('pending')).toBeInTheDocument()
    expect(within(flappyLink).getByText('Results not released')).toBeInTheDocument()
    expect(flappyLink).toHaveAccessibleName(/Week 4 pending Submitted .* Results not released/)

    const heartsLink = screen.getByRole('link', {
      name: 'Season week-2 Not submitted Results not released',
    })
    expect(within(heartsLink).getByText('Not submitted')).toBeInTheDocument()
    expect(heartsLink).toHaveAccessibleName('Season week-2 Not submitted Results not released')
    expect(screen.queryByText('Open agent profile')).toBeNull()
  })

  it('shows at most three previous seasons and preserves zero, negative, and missing scores', async () => {
    vi.mocked(getMyAgents).mockResolvedValue([
      {
        env_id: 'flappy_bird',
        current_season: null,
        previous_seasons: [
          season('zero', { label: 'Zero', mean_score: 0 }),
          season('negative', { label: 'Negative', mean_score: -2.5 }),
          season('missing', { label: 'Missing', mean_score: null }),
          season('hidden', { label: 'Hidden', mean_score: 99 }),
        ],
      },
    ])

    await renderPage()

    expect(await screen.findByText('Score 0.00')).toBeInTheDocument()
    expect(screen.getByText('Score -2.50')).toBeInTheDocument()
    expect(screen.getByText('No score')).toBeInTheDocument()
    expect(screen.queryByText('Hidden')).toBeNull()
    expect(screen.getAllByRole('link')).toHaveLength(3)
    expect(
      screen.getByRole('link', { name: /Zero ready to compete Submitted .* Score 0.00/ }),
    ).toBeInTheDocument()
  })

  it('distinguishes unreleased results from a released season without a score', async () => {
    vi.mocked(getMyAgents).mockResolvedValue([
      {
        env_id: 'flappy_bird',
        current_season: null,
        previous_seasons: [
          season('unreleased', { release_status: 'unreleased', mean_score: null }),
          season('released', { release_status: 'released', mean_score: null }),
        ],
      },
    ])

    await renderPage()

    expect(await screen.findByText('Results not released')).toBeInTheDocument()
    expect(screen.getByText('No score')).toBeInTheDocument()
  })

  it('shows loading while the authenticated summary is still pending', async () => {
    vi.mocked(getMyAgents).mockReturnValue(new Promise(() => {}))

    await renderPage()

    expect(await screen.findByText('Loading…')).toBeInTheDocument()
  })

  it('lets a pending user inspect the same current-Season summary', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('pending-student', 'pending'))
    vi.mocked(getMyAgents).mockResolvedValue([
      {
        env_id: 'flappy_bird',
        current_season: season('week-4', {
          label: 'Week 4',
          release_status: 'unreleased',
          submission: null,
          mean_score: null,
        }),
        previous_seasons: [],
      },
    ])

    await renderPage()

    expect(
      await screen.findByRole('link', {
        name: 'Week 4 Not submitted Results not released',
      }),
    ).toHaveAttribute('href', '/environments/flappy_bird/agents/pending-student?season=week-4')
    expect(vi.mocked(getMyAgents)).toHaveBeenCalledOnce()
  })

  it('prompts anonymous visitors to sign in without requesting protected summaries', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)

    await renderPage()

    expect(await screen.findByText(/Sign in to see your agents/)).toBeInTheDocument()
    expect(vi.mocked(getMyAgents)).not.toHaveBeenCalled()
    expect(vi.mocked(loadEnvironmentCatalog)).not.toHaveBeenCalled()
  })

  it('shows a stable error state when summaries fail', async () => {
    vi.mocked(getMyAgents).mockRejectedValue(new Error('offline'))

    await renderPage()

    expect(await screen.findByText('Could not load your agents.')).toBeInTheDocument()
  })
})
