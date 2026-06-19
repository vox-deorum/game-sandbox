import { screen, waitFor, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Board, SeasonView } from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(async () => ({ user_id: 'dev-user', allowlisted: true, is_operator: false })),
  getEnvironments: vi.fn(),
  getEnvironmentLeaderboards: vi.fn(),
  getSeasonLeaderboards: vi.fn(),
  listReleasedSeasons: vi.fn(),
}))

import {
  getEnvironmentLeaderboards,
  getEnvironments,
  getSeasonLeaderboards,
  listReleasedSeasons,
} from '../src/api/client.js'
import LeaderboardsPage from '../src/pages/LeaderboardsPage.vue'

function season(overrides: Partial<SeasonView> = {}): SeasonView {
  return {
    id: 'iter-1',
    env_id: 'flappy_bird',
    submission_status: 'closed',
    play_status: 'closed',
    release_status: 'released',
    label: 'Week 1',
    config: { deps_version: 1, matches: [] },
    rating_prompt: null,
    created_at: '2026-06-10T00:00:00Z',
    released_at: '2026-06-12T00:00:00Z',
    ...overrides,
  }
}

function board(): Board {
  return {
    automated: [
      {
        agent: { kind: 'submission', submission_id: 's1', user_id: 'alice' },
        mean_score: 9.5,
        mean_agent_compute_ms: 2.5,
        failure_count: 0,
        games: 2,
        recording_id: 'rec-a',
      },
      {
        agent: { kind: 'builtin-naive' },
        mean_score: 3,
        mean_agent_compute_ms: 1,
        failure_count: 1,
        games: 2,
        recording_id: 'rec-n',
      },
    ],
    human: [
      {
        agent: { kind: 'submission', submission_id: 's1', user_id: 'alice' },
        mean: 4.2,
        count: 5,
        rank: 1,
      },
      { agent: { kind: 'builtin-naive' }, mean: 3, count: 2, rank: null },
    ],
  }
}

const ReplayStub = { template: '<div>replay {{ $route.params.id }}</div>' }
const AgentStub = { template: '<div>agent {{ $route.params.ownerId }}</div>' }

async function renderAt(path: string) {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: AgentStub },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: LeaderboardsPage },
    { path: '/replays/:id', component: ReplayStub },
  ])
  router.push(path)
  await router.isReady()
  return renderWithMe(router)
}

describe('LeaderboardsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
    vi.mocked(listReleasedSeasons).mockResolvedValue([
      season({ id: 'iter-1', label: 'Week 1' }),
      season({ id: 'iter-0', label: 'Week 0' }),
    ])
  })

  it('renders both boards side by side from the current released season', async () => {
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    expect(await screen.findByText('Automated board')).toBeInTheDocument()
    expect(screen.getByText('Human feedback')).toBeInTheDocument()

    // The automated board shows the weighted mean agent compute time as its own column.
    expect(screen.getByRole('columnheader', { name: 'Agent compute' })).toBeInTheDocument()
    expect(screen.getByText('2.5 ms')).toBeInTheDocument()

    // The submitted agent links to its profile; the Naive baseline row is present and ownerless.
    const aliceLink = screen.getAllByRole('link', { name: 'alice' })[0] as HTMLElement
    expect(aliceLink).toHaveAttribute('href', '/environments/flappy_bird/agents/alice')
    expect(screen.getAllByText('Naive baseline').length).toBeGreaterThan(0)

    // The per-row replay deep-links the representative recording.
    const replay = screen.getAllByRole('link', { name: 'Replay' })[0] as HTMLElement
    expect(replay).toHaveAttribute('href', '/replays/rec-a')

    // The default route reads the public environment leaderboards, never the admin board.
    expect(vi.mocked(getEnvironmentLeaderboards)).toHaveBeenCalledWith('flappy_bird')
    expect(vi.mocked(getSeasonLeaderboards)).not.toHaveBeenCalled()
  })

  it('ranks the human board at three ratings and leaves under-threshold rows unranked', async () => {
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    // The human board is its own section, so scope row queries to it rather than crossing into the
    // automated board.
    const humanHeading = await screen.findByText('Human feedback')
    const humanSection = humanHeading.closest('section') as HTMLElement
    const rows = within(humanSection).getAllByRole('row')
    const rankedRow = rows[1] as HTMLElement
    const unrankedRow = rows[2] as HTMLElement
    // Header + two agent rows. The ranked agent (5 ratings) is row 1 with rank 1 and mean 4.2; the
    // 2-rating Naive row is row 2, unranked (an em dash where its rank would be).
    expect(within(rankedRow).getByText('1')).toBeInTheDocument()
    expect(within(rankedRow).getByText('4.2')).toBeInTheDocument()
    expect(within(unrankedRow).getByText('—')).toBeInTheDocument()
  })

  it('resolves a specific season by URL through the released-only read', async () => {
    vi.mocked(getSeasonLeaderboards).mockResolvedValue({
      season: season({ id: 'iter-0', label: 'Week 0' }),
      board: board(),
    })
    await renderAt('/environments/flappy_bird/leaderboards/iter-0')

    await waitFor(() =>
      expect(vi.mocked(getSeasonLeaderboards)).toHaveBeenCalledWith('flappy_bird', 'iter-0'),
    )
    expect(screen.getByText('Week 0')).toBeInTheDocument()
    // History links are present for navigation between released seasons.
    expect(screen.getByRole('link', { name: 'Week 1' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards/iter-1',
    )
  })

  it('shows a not-released message for an unreleased or unknown season (404)', async () => {
    vi.mocked(getSeasonLeaderboards).mockResolvedValue(undefined)
    await renderAt('/environments/flappy_bird/leaderboards/iter-secret')
    expect(await screen.findByText(/No released results/)).toBeInTheDocument()
  })
})
