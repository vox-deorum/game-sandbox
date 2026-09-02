import { fireEvent, screen, waitFor, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Board, Me, ResolvedSeasonSettings, SeasonView } from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  // The factory is hoisted above imports, so it inlines the signed-in `/api/me` shape rather than
  // calling the shared helper (a runtime value, unavailable this early). The `Promise<Me>` annotation
  // type-checks the literal against the production shape so it cannot drift. Matches
  // signedInMe('dev-user','normal').
  getMe: vi.fn(
    async (): Promise<Me> => ({
      user: {
        id: 'dev-user',
        name: 'dev-user',
        email: 'dev-user@test.local',
        image: null,
        github_username: null,
        status: 'normal',
      },
    }),
  ),
  getEnvironments: vi.fn(),
  getEnvironmentLeaderboards: vi.fn(),
  getSeasonLeaderboards: vi.fn(),
  getAdminSeason: vi.fn(),
  listSeasons: vi.fn(),
  // The leaderboards page mounts SeasonRatings for an operator, which lists ratings on mount; default
  // it to an empty read so the section renders its empty states without a real fetch.
  listSeasonRatings: vi.fn(async () => ({ by_agent: [], by_rater: [] })),
}))

import {
  getAdminSeason,
  getEnvironmentLeaderboards,
  getEnvironments,
  getMe,
  getSeasonLeaderboards,
  listSeasonRatings,
  listSeasons,
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
    description_markdown: null,
    created_at: '2026-06-10T00:00:00Z',
    released_at: '2026-06-12T00:00:00Z',
    ...overrides,
  }
}

function settings(): ResolvedSeasonSettings {
  return {
    values: { players: 1, pipe_gap: 90 },
    rules: {
      step_timeout_ms: 1000,
      episode_timeout_ms: 120_000,
      messaging_enabled: false,
      message_cap: null,
      llm_enabled: false,
    },
  }
}

function board(): Board {
  return {
    automated: [
      {
        agent: { kind: 'submission', submission_id: 's1', user_id: 'alice' },
        mean_score: 9.5,
        score_std: 1.5,
        mean_agent_compute_ms: 2.5,
        compute_std: 0.5,
        llm_usage_by_model: null,
        llm_weighted_cost: null,
        failure_count: 0,
        games: 2,
        recording_id: 'rec-a',
      },
      {
        agent: { kind: 'builtin', name: 'naive' },
        mean_score: 3,
        score_std: 0,
        mean_agent_compute_ms: 1,
        compute_std: 0,
        llm_usage_by_model: null,
        llm_weighted_cost: null,
        failure_count: 1,
        games: 2,
        recording_id: 'rec-n',
      },
    ],
    human: [
      {
        agent: { kind: 'submission', submission_id: 's1', user_id: 'alice' },
        mean: 4.2,
        std: 0.8,
        count: 5,
        rank: 1,
        recording_id: 'rec-a',
        author_prompt: 'Reward smooth, human-like play.',
      },
      {
        agent: { kind: 'builtin', name: 'naive' },
        mean: 3,
        std: 0,
        count: 2,
        rank: null,
        recording_id: 'rec-n',
        author_prompt: null,
      },
    ],
    games: [],
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
    { path: '/environments/:envId/admin', component: { template: '<div />' } },
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
    vi.mocked(listSeasons).mockResolvedValue([
      {
        ...season({ id: 'iter-1', label: 'Week 1' }),
        submission_count: 2,
        game_count: 12,
      },
      {
        ...season({ id: 'iter-0', label: 'Week 0' }),
        submission_count: 1,
        game_count: 6,
      },
    ])
  })

  it('renders both boards in one column from the current released season', async () => {
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    await screen.findByText('Scoreboard')
    expect(screen.getByText('Human Ratings')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Season: Week 1', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('2 submissions')).toBeInTheDocument()
    expect(screen.getByText('12 games run')).toBeInTheDocument()
    const settingsBox = screen.getByRole('group', { name: 'Settings for season Week 1' })
    expect(settingsBox).toHaveClass('ui-card', 'info')
    expect(within(settingsBox).queryByText('Settings:')).toBeNull()
    expect(screen.getByText('Pipe gap from 100 to 90')).toBeInTheDocument()

    // The automated board shows the weighted mean agent compute time as its own column, with the
    // game-to-game spread beside it.
    expect(screen.getByRole('columnheader', { name: 'Agent compute' })).toBeInTheDocument()
    expect(screen.getByText('2.5 ± 0.5 ms')).toBeInTheDocument()
    // The mean score carries its spread too, both to two decimals.
    expect(screen.getByText('9.50 ± 1.50')).toBeInTheDocument()

    // The submitted agent links to its profile; the Naive baseline row is present and ownerless. No
    // user_name on this board fixture, so the link text falls back to the stable user_id, which is also
    // the link target and its own tooltip.
    const aliceLink = screen.getAllByRole('link', { name: 'alice' })[0] as HTMLElement
    expect(aliceLink).toHaveAttribute('href', '/environments/flappy_bird/agents/alice')
    expect(aliceLink).toHaveAttribute('title', 'alice')
    expect(screen.getAllByText('naive').length).toBeGreaterThan(0)

    // The per-row replay deep-links the representative recording.
    const replay = screen.getAllByRole('link', { name: 'Replay' })[0] as HTMLElement
    expect(replay).toHaveAttribute('href', '/replays/rec-a')

    // The default route reads the public environment leaderboards, never the admin board.
    expect(vi.mocked(getEnvironmentLeaderboards)).toHaveBeenCalledWith('flappy_bird')
    expect(vi.mocked(getSeasonLeaderboards)).not.toHaveBeenCalled()
  })

  it('shows the empty-automated-board copy and keeps Human Ratings after Scoreboard in DOM order', async () => {
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: { ...board(), automated: [] } },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    await screen.findByText('No automated results yet.')
    const scoreboard = screen.getByText('Scoreboard').closest('section') as HTMLElement
    const humanRatings = screen.getByText('Human Ratings').closest('section') as HTMLElement
    expect(
      scoreboard.compareDocumentPosition(humanRatings) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('ranks the human board at three ratings and leaves under-threshold rows unranked', async () => {
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    // The human board is its own section, so scope row queries to it rather than crossing into the
    // automated board.
    const humanHeading = await screen.findByText('Human Ratings')
    const humanSection = humanHeading.closest('section') as HTMLElement
    const rows = within(humanSection).getAllByRole('row')
    const rankedRow = rows[1] as HTMLElement
    const unrankedRow = rows[2] as HTMLElement
    // Header + two agent rows. The ranked agent (5 ratings) is row 1 with rank 1 and mean 4.2; the
    // 2-rating Naive row is row 2, unranked (an em dash where its rank would be).
    expect(within(rankedRow).getByText('1')).toBeInTheDocument()
    expect(within(rankedRow).getByText('4.2 ± 0.8')).toBeInTheDocument()
    expect(within(unrankedRow).getByText('None')).toBeInTheDocument()
  })

  it('shows compact stored LLM usage with honest per-model details on the automated board only', async () => {
    const usageBoard = board()
    const usageRow = usageBoard.automated[0] as Board['automated'][number]
    usageBoard.automated[0] = {
      ...usageRow,
      llm_weighted_cost: 41_600,
      llm_usage_by_model: {
        small: {
          calls: 2,
          estimated_calls: 0,
          input_tokens: 100,
          reasoning_tokens: 20,
          output_tokens: 50,
          latency_ms: 9,
        },
        medium: {
          calls: 1,
          estimated_calls: 0,
          input_tokens: 40,
          reasoning_tokens: 5,
          output_tokens: 10,
          latency_ms: 4,
        },
      },
    }
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: usageBoard },
      submission_season_id: null,
      play_season_id: null,
    })
    const view = await renderAt('/environments/flappy_bird/leaderboards')

    const automatedSection = (await screen.findByText('Scoreboard')).closest(
      'section',
    ) as HTMLElement
    const humanSection = screen.getByText('Human Ratings').closest('section') as HTMLElement
    expect(
      within(automatedSection).getByRole('columnheader', { name: 'LLM usage' }),
    ).toBeInTheDocument()
    expect(within(humanSection).queryByRole('columnheader', { name: 'LLM usage' })).toBeNull()
    expect(automatedSection.querySelector('.llm-total')).toHaveTextContent('41.6k units')
    expect(within(automatedSection).getByText('None')).toBeInTheDocument()

    await fireEvent.click(within(automatedSection).getByText('By model'))
    expect(within(automatedSection).getByText('small').closest('li')).toHaveTextContent(
      'small: 2 calls, 100 input + 50 output tokens, 20 reasoning tokens within output',
    )
    expect(within(automatedSection).getByText('medium').closest('li')).toHaveTextContent(
      'medium: 1 call, 40 input + 10 output tokens, 5 reasoning tokens within output',
    )

    const firstRow = within(automatedSection).getAllByRole('row')[1] as HTMLElement
    expect(within(firstRow).getAllByRole('cell')[0]).toHaveTextContent('1')
    expect(view.container.querySelector('.automated-table')?.parentElement).toHaveClass(
      'board-scroll',
    )
  })

  it("shows an agent's author rating prompt under its name on the human board", async () => {
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    const humanHeading = await screen.findByText('Human Ratings')
    const humanSection = humanHeading.closest('section') as HTMLElement
    // The ranked agent's prompt shows (full text in the title); the ownerless Naive row has none.
    const prompt = within(humanSection).getByText(/Reward smooth, human-like play\./)
    expect(prompt).toHaveAttribute('title', 'Reward smooth, human-like play.')
  })

  it('resolves a specific season by URL through the released-only read', async () => {
    vi.mocked(getSeasonLeaderboards).mockResolvedValue({
      season: season({ id: 'iter-0', label: 'Week 0' }),
      settings: settings(),
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
    await screen.findByText(/No released results/)
    // A non-operator never reaches the operator-only admin read.
    expect(vi.mocked(getAdminSeason)).not.toHaveBeenCalled()
  })

  it('lets an operator preview an unreleased season board through the admin read', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(getSeasonLeaderboards).mockResolvedValue(undefined)
    vi.mocked(getAdminSeason).mockResolvedValue({
      season: season({
        id: 'iter-secret',
        label: 'Secret',
        release_status: 'unreleased',
        released_at: null,
      }),
      settings: settings(),
      eligible_submission_count: 0,
      latest_run: null,
      board: board(),
    })
    await renderAt('/environments/flappy_bird/leaderboards/iter-secret')

    await waitFor(() => expect(vi.mocked(getAdminSeason)).toHaveBeenCalledWith('iter-secret'))
    await screen.findByText('Scoreboard')
    expect(screen.getByText(/Operator preview/)).toBeInTheDocument()
  })

  it('lists unreleased seasons in the history table for an operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(listSeasons).mockResolvedValue([
      {
        ...season({
          id: 'iter-2',
          label: 'Week 2',
          release_status: 'unreleased',
          released_at: null,
        }),
        submission_count: 0,
        game_count: 0,
      },
      {
        ...season({ id: 'iter-1', label: 'Week 1' }),
        submission_count: 2,
        game_count: 12,
      },
    ])
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    // The operator listing asks for unreleased seasons, and the unreleased one shows in the table.
    await waitFor(() =>
      expect(vi.mocked(listSeasons)).toHaveBeenCalledWith('flappy_bird', {
        includeUnreleased: true,
      }),
    )
    await screen.findByRole('link', { name: 'Week 2' })
  })

  it('prefers a submitted agent row user_name over its user_id, keeping the id for the link and tooltip', async () => {
    const namedBoard: Board = {
      automated: [
        {
          agent: {
            kind: 'submission',
            submission_id: 's1',
            user_id: 'alice',
            user_name: 'Alice Nguyen',
          },
          mean_score: 9.5,
          score_std: 1.5,
          mean_agent_compute_ms: 2.5,
          compute_std: 0.5,
          llm_usage_by_model: null,
          llm_weighted_cost: null,
          failure_count: 0,
          games: 2,
          recording_id: 'rec-a',
        },
      ],
      // No human rows, so the only 'alice'-owned row on the page is the automated one under test.
      human: [],
      games: [],
    }
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: namedBoard },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    const link = await screen.findByRole('link', { name: 'Alice Nguyen' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/agents/alice')
    expect(link).toHaveAttribute('title', 'alice')
    expect(screen.queryByText('alice', { exact: true })).toBeNull()
  })

  it("shows the released-season matchup table's players cell with a stable-id tooltip", async () => {
    // The matchup table (GamesTable) never applies blind masking on a released-season payload, so its
    // players cell carries the joined submission ids as a tooltip alongside the display text.
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: {
        season: season(),
        settings: settings(),
        board: {
          ...board(),
          games: [
            {
              id: 'g1',
              run_id: 'run-1',
              match_index: 0,
              game_index: 0,
              seed: 0,
              seats: [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }],
              status: 'completed',
              recording_id: 'rec-a',
              started_at: null,
              ended_at: null,
              error: null,
            },
          ],
        },
      },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    const gameRow = await screen.findByTestId('game-row')
    const playersCell = within(gameRow).getByText('alice')
    expect(playersCell).toHaveAttribute('title', 'alice')
  })

  it('requests only the released listing for a non-operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    await waitFor(() => expect(vi.mocked(listSeasons)).toHaveBeenCalledWith('flappy_bird'))
  })

  it('shows a Manage season link to the console for an operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    const link = await screen.findByRole('link', { name: 'Manage season' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/admin?season=iter-1')
  })

  it('hides the peer-ratings section and the Manage season link from a non-operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    await screen.findByText('Scoreboard')
    expect(screen.queryByText('Peer Ratings')).toBeNull()
    expect(screen.queryByRole('link', { name: 'Manage season' })).toBeNull()
    expect(vi.mocked(listSeasonRatings)).not.toHaveBeenCalled()
  })

  it('renders both peer-ratings tables for an operator, below the boards', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    vi.mocked(listSeasonRatings).mockResolvedValue({
      by_agent: [
        {
          agent: { kind: 'submission', submission_id: 's1', user_id: 'u1', user_name: 'Dana Wu' },
          mean: 4,
          count: 2,
          ratings: [
            {
              score: 5,
              feedback: 'Held the gap',
              rated_at: '2026-06-12T00:00:00Z',
              rater_user_id: 'r1',
              rater_name: 'Kim Lee',
            },
          ],
        },
      ],
      by_rater: [
        { rater_user_id: 'r0', rater_name: 'Ana Roy', count: 0, ratings: [] },
        {
          rater_user_id: 'r1',
          rater_name: 'Kim Lee',
          count: 1,
          ratings: [
            {
              score: 5,
              feedback: 'Held the gap',
              rated_at: '2026-06-12T00:00:00Z',
              agent: {
                kind: 'submission',
                submission_id: 's1',
                user_id: 'u1',
                user_name: 'Dana Wu',
              },
            },
          ],
        },
      ],
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    await screen.findByRole('heading', { name: 'Peer Ratings' })
    const byAgent = (await screen.findByRole('heading', { name: 'By agent' })).closest('section')
    const byRater = (await screen.findByRole('heading', { name: 'By rater' })).closest('section')
    expect(byAgent).not.toBeNull()
    expect(byRater).not.toBeNull()
    expect(within(byAgent as HTMLElement).getByText('Dana Wu')).toBeInTheDocument()
    expect(within(byAgent as HTMLElement).getByText('4.0')).toBeInTheDocument()
    expect(within(byAgent as HTMLElement).getByText('2')).toBeInTheDocument()
    expect(within(byRater as HTMLElement).getByText('Kim Lee')).toBeInTheDocument()
    expect(within(byRater as HTMLElement).getByText('1')).toBeInTheDocument()
    expect(within(byRater as HTMLElement).getByText('Ana Roy')).toBeInTheDocument()
    expect(within(byRater as HTMLElement).getByText('0')).toBeInTheDocument()
  })

  it('opens the by-agent drill-in dialog for an operator with the named raters', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    vi.mocked(listSeasonRatings).mockResolvedValue({
      by_agent: [
        {
          agent: { kind: 'submission', submission_id: 's1', user_id: 'u1', user_name: 'Dana Wu' },
          mean: 4,
          count: 2,
          ratings: [
            {
              score: 5,
              feedback: 'Held the gap',
              rated_at: '2026-06-12T00:00:00Z',
              rater_user_id: 'r1',
              rater_name: 'Kim Lee',
            },
          ],
        },
      ],
      by_rater: [],
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    const byAgentSection = (await screen.findByRole('heading', { name: 'By agent' })).closest(
      'section',
    ) as HTMLElement
    await fireEvent.click(within(byAgentSection).getByRole('button', { name: 'Dana Wu' }))

    const dialog = await screen.findByRole('dialog', { name: 'Dana Wu · 2 ratings' })
    expect(within(dialog).getByText('★ 5')).toBeInTheDocument()
    expect(within(dialog).getByText('Kim Lee')).toBeInTheDocument()
    expect(within(dialog).getByText('Held the gap')).toBeInTheDocument()
  })

  it('opens the by-rater drill-in dialog for an operator with the rated agent', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    vi.mocked(listSeasonRatings).mockResolvedValue({
      by_agent: [],
      by_rater: [
        {
          rater_user_id: 'r1',
          rater_name: 'Kim Lee',
          count: 1,
          ratings: [
            {
              score: 5,
              feedback: 'Held the gap',
              rated_at: '2026-06-12T00:00:00Z',
              agent: {
                kind: 'submission',
                submission_id: 's1',
                user_id: 'u1',
                user_name: 'Dana Wu',
              },
            },
          ],
        },
      ],
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    const byRaterSection = (await screen.findByRole('heading', { name: 'By rater' })).closest(
      'section',
    ) as HTMLElement
    await fireEvent.click(within(byRaterSection).getByText('Kim Lee'))

    const dialog = await screen.findByRole('dialog', { name: 'Kim Lee · rated 1 agent' })
    expect(within(dialog).getByText('★ 5')).toBeInTheDocument()
    expect(within(dialog).getByText('Dana Wu')).toBeInTheDocument()
    expect(within(dialog).getByText('Held the gap')).toBeInTheDocument()
  })

  it('keeps a zero-count rater row non-clickable for an operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: { season: season(), settings: settings(), board: board() },
      submission_season_id: null,
      play_season_id: null,
    })
    vi.mocked(listSeasonRatings).mockResolvedValue({
      by_agent: [],
      by_rater: [{ rater_user_id: 'r0', rater_name: 'Ana Roy', count: 0, ratings: [] }],
    })
    await renderAt('/environments/flappy_bird/leaderboards')

    const byRaterSection = (await screen.findByRole('heading', { name: 'By rater' })).closest(
      'section',
    ) as HTMLElement
    const zeroRow = byRaterSection.querySelector('tr.zero') as HTMLElement
    expect(zeroRow).not.toBeNull()
    expect(within(byRaterSection).getByText('Ana Roy')).toBeInTheDocument()
    await fireEvent.click(within(byRaterSection).getByText('Ana Roy'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Ana Roy · rated 0 agents')).toBeNull()
  })
})
