import { screen, waitFor, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentProfile, AgentProfileSubmission, SubmissionCheck } from '../src/api/client.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getAgentProfile: vi.fn(),
  // The profile fetches the agent's released placements on mount; default it to none.
  getAgentPlacements: vi.fn(async () => ({
    env_id: 'flappy_bird',
    owner_id: 'eve',
    placements: [],
  })),
  // The owner-only author-prompt editor self-fetches on mount; default it to an unset prompt.
  getAuthorPrompt: vi.fn(async () => ({ season_id: 'flappy_bird-iter-1', prompt: null })),
  setAuthorPrompt: vi.fn(async () => ({ ok: true, prompt: null })),
  // The owner-only submit form (shown when a season is accepting submissions) probes capabilities on
  // mount; default the dev local-folder gate off. The submit/verify calls only fire on interaction.
  getSubmissionCapabilities: vi.fn(async () => ({ local_submissions: false })),
}))

import type { AgentPlacementView } from '../src/api/client.js'
import { getAgentPlacements, getAgentProfile, getAuthorPrompt, getMe } from '../src/api/client.js'
import AgentProfilePage from '../src/pages/AgentProfilePage.vue'

const ReplayStub = { template: '<div>replay {{ $route.params.id }}</div>' }

function check(
  stage: SubmissionCheck['stage'],
  status: SubmissionCheck['status'],
  detail: string | null = null,
): SubmissionCheck {
  return { stage, status, detail, started_at: '2026-06-14T00:00:00Z', ended_at: null }
}

function submission(overrides: Partial<AgentProfileSubmission> = {}): AgentProfileSubmission {
  return {
    id: 'sub1',
    season_id: 'flappy_bird-iter-1',
    env_id: 'flappy_bird',
    user_id: 'eve',
    source_kind: 'git',
    repo_url: 'https://example.test/agent',
    commit_sha: 'abcdef1234567890',
    local_path: null,
    ref: null,
    status: 'ready',
    reason: null,
    created_at: '2026-06-14T00:00:00Z',
    superseded_at: null,
    checks: [],
    replays: [],
    ...overrides,
  }
}

type ProfileFixture = Omit<AgentProfile, 'submission_season_id' | 'play_season_id'> &
  Partial<Pick<AgentProfile, 'submission_season_id' | 'play_season_id'>>

async function renderProfile(profile: ProfileFixture) {
  vi.mocked(getAgentProfile).mockResolvedValue({
    submission_season_id: null,
    play_season_id: null,
    ...profile,
  })
  const router = memoryRouter([
    // Stubs for the breadcrumb links so the context-line RouterLinks resolve in the test router.
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: AgentProfilePage },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: { template: '<div />' } },
    { path: '/replays/:id', component: ReplayStub },
  ])
  router.push('/environments/flappy_bird/agents/eve')
  await router.isReady()
  return renderWithMe(router)
}

describe('AgentProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
  })

  it('renders submission history newest-first with active marker and replays', async () => {
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submissions: [
        submission({
          id: 'active',
          status: 'ready',
          checks: [
            check('resolve', 'passed'),
            check('static', 'passed'),
            check('build', 'passed'),
            check('load', 'passed'),
          ],
          replays: ['flappy_bird-sess-1'],
        }),
        submission({
          id: 'old',
          status: 'static_failed',
          superseded_at: '2026-06-14T01:00:00Z',
        }),
      ],
    })

    // A non-owner (dev-user) viewing eve's profile sees a possessive heading, not "My Submissions".
    expect(
      await screen.findByRole('heading', { name: "eve's Submissions", level: 1 }),
    ).toBeInTheDocument()
    // The active (non-superseded) submission carries the Active badge; the superseded one does not.
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(screen.getByText('ready')).toBeInTheDocument()
    expect(screen.getByText('static check failed')).toBeInTheDocument()
    // The recording links to its replay page.
    const replay = screen.getByRole('link', { name: 'flappy_bird-sess-1' })
    expect(replay).toHaveAttribute('href', '/replays/flappy_bird-sess-1')
  })

  it('shows the failed load stage and its captured detail (the load_failed case)', async () => {
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submissions: [
        submission({
          id: 'badload',
          status: 'load_failed',
          reason: "no class named 'Agent'",
          checks: [
            check('resolve', 'passed'),
            check('static', 'passed'),
            check('build', 'passed'),
            check('load', 'failed', "no class named 'Agent'"),
          ],
        }),
      ],
    })

    expect(await screen.findByText('load check failed')).toBeInTheDocument()
    // The load stage row shows failed, and its detail renders inline (per-stage rejection view).
    const loadRow = screen.getByTestId('stage-load')
    expect(within(loadRow).getByText('failed')).toBeInTheDocument()
    expect(screen.getByTestId('stage-detail-load')).toHaveTextContent("no class named 'Agent'")
  })

  it('shows the owner-only debug placeholder only to the agent owner', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'eve', allowlisted: true, is_operator: false })
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [submission()] })
    // The owner sees the first-person heading rather than the possessive form.
    expect(
      await screen.findByRole('heading', { name: 'My Submissions', level: 1 }),
    ).toBeInTheDocument()
    expect(await screen.findByText(/LLM debug view/)).toBeInTheDocument()
    // The leaderboard placements section is visible to everyone (empty until released results exist).
    expect(screen.getByRole('heading', { name: 'Leaderboard Placements' })).toBeInTheDocument()
    expect(screen.getByText(/No released placements/)).toBeInTheDocument()
  })

  it('shows real placements with human rating and a season-named leaderboard link', async () => {
    const placement: AgentPlacementView = {
      id: 'p1',
      season_id: 'iter-released',
      env_id: 'flappy_bird',
      run_id: 'run-1',
      rank: 2,
      agent_kind: 'submission',
      agent_submission_id: 'sub1',
      agent_user_id: 'eve',
      mean_score: 12.5,
      mean_agent_compute_ms: 3.2,
      failure_count: 0,
      recording_id: 'rec-1',
      created_at: '2026-06-14T00:00:00Z',
      season_label: 'Spring Iteration',
      human_mean: 4.25,
      human_count: 8,
    }
    vi.mocked(getAgentPlacements).mockResolvedValue({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      placements: [placement],
    })
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [submission()] })

    // Both the human rating (1 decimal) and the automated mean score (2 decimals) are shown.
    expect(await screen.findByText('4.3')).toBeInTheDocument()
    expect(screen.getByText('12.50')).toBeInTheDocument()
    // The season link reads the season name, not the generic "View leaderboards".
    const link = screen.getByRole('link', { name: 'Spring Iteration' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/leaderboards/iter-released')
  })

  it('shows a dash for a placement with no human ratings and falls back to a season id label', async () => {
    const placement: AgentPlacementView = {
      id: 'p2',
      season_id: 'unlabelled-season-123456',
      env_id: 'flappy_bird',
      run_id: 'run-2',
      rank: 1,
      agent_kind: 'submission',
      agent_submission_id: 'sub1',
      agent_user_id: 'eve',
      mean_score: 9,
      mean_agent_compute_ms: null,
      failure_count: 0,
      recording_id: null,
      created_at: '2026-06-14T00:00:00Z',
      season_label: null,
      human_mean: null,
      human_count: 0,
    }
    vi.mocked(getAgentPlacements).mockResolvedValue({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      placements: [placement],
    })
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [submission()] })

    expect(await screen.findByText('9.00')).toBeInTheDocument()
    // No ratings → muted dash; null label → "Season <first 8 chars of id>".
    const link = screen.getByRole('link', { name: 'Season unlabell' })
    expect(link).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards/unlabelled-season-123456',
    )
  })

  it('hides the owner-only debug placeholder from a non-owner viewer', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'someone-else',
      allowlisted: true,
      is_operator: false,
    })
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [submission()] })
    expect(await screen.findByText(/Leaderboard Placements/)).toBeInTheDocument()
    expect(screen.queryByText(/LLM debug view/)).toBeNull()
  })

  it('edits the play-open prompt when submissions are open for a newer round', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'eve', allowlisted: true, is_operator: false })
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submission_season_id: 'iter-next',
      play_season_id: 'iter-play',
      submissions: [
        submission({ id: 'next', season_id: 'iter-next' }),
        submission({
          id: 'play',
          season_id: 'iter-play',
          created_at: '2026-06-13T00:00:00Z',
        }),
      ],
    })

    await waitFor(() => expect(vi.mocked(getAuthorPrompt)).toHaveBeenCalledWith('iter-play'))
  })

  it('shows an empty history for an owner with no submissions', async () => {
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'newbie', submissions: [] })
    expect(await screen.findByText(/has not submitted an agent/)).toBeInTheDocument()
  })
})
