import { fireEvent, screen, waitFor, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentProfile, AgentProfileSubmission, SubmissionCheck } from '../src/api/client.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getAgentProfile: vi.fn(),
  listSeasons: vi.fn(async () => []),
  // The profile fetches the agent's released placements on mount; default it to none.
  getAgentPlacements: vi.fn(async () => ({
    env_id: 'flappy_bird',
    owner_id: 'eve',
    placements: [],
  })),
  // The owner-only submit form prefills the rating prompt from the submission season on mount; default
  // it to an unset prompt. setAuthorPrompt only fires after a submission is accepted.
  getAuthorPrompt: vi.fn(async () => ({ season_id: 'flappy_bird-iter-1', prompt: null })),
  setAuthorPrompt: vi.fn(async () => ({ ok: true, prompt: null })),
  // The owner-only submit form (shown when a season is accepting submissions) probes capabilities on
  // mount; default the dev local-folder gate off. The submit/verify calls only fire on interaction.
  getSubmissionCapabilities: vi.fn(async () => ({ local_submissions: false })),
  checkReachability: vi.fn(),
  submitAgent: vi.fn(),
  getSubmission: vi.fn(),
}))

import type { AgentPlacementView } from '../src/api/client.js'
import {
  checkReachability,
  getAgentPlacements,
  getAgentProfile,
  getAuthorPrompt,
  getMe,
  getSubmission,
  listSeasons,
  submitAgent,
} from '../src/api/client.js'
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

type ProfileFixture = Omit<
  AgentProfile,
  'submission_season_id' | 'play_season_id' | 'author_prompts'
> &
  Partial<Pick<AgentProfile, 'submission_season_id' | 'play_season_id' | 'author_prompts'>>

async function renderProfile(
  profile: ProfileFixture,
  path = '/environments/flappy_bird/agents/eve',
) {
  vi.mocked(getAgentProfile).mockResolvedValue({
    submission_season_id: null,
    play_season_id: null,
    author_prompts: {},
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
  router.push(path)
  await router.isReady()
  return { router, view: renderWithMe(router) }
}

describe('AgentProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(listSeasons).mockResolvedValue([])
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
    // No owner_name on this fixture, so the heading falls back to the stable owner id — and that id
    // stays available as the heading's tooltip either way.
    const heading = await screen.findByRole('heading', { name: "eve's Submissions", level: 1 })
    expect(heading).toBeInTheDocument()
    expect(heading).toHaveAttribute('title', 'eve')
    // The active ready submission reads "ready to compete" (the old standalone "Current" marker is
    // folded into the status label); the superseded static-check failure keeps its own status. Both
    // submissions' rollup status reads from the summary row (the superseded one stays collapsed, but
    // its summary still shows its status).
    expect(screen.getByText('ready to compete')).toBeInTheDocument()
    expect(screen.getByText('static check failed')).toBeInTheDocument()
    // The standalone "Current" badge is gone — lifecycle now rides on the status badge.
    expect(screen.queryByText('Current')).toBeNull()
    // Each summary row leads with its season name (single season here, so the group caption is hidden
    // and the name shows once per row).
    expect(screen.getAllByText('Season flappy_b')).toHaveLength(2)
    // The recording links to its replay page.
    const replay = screen.getByRole('link', { name: 'flappy_bird-sess-1' })
    expect(replay).toHaveAttribute('href', '/replays/flappy_bird-sess-1')
  })

  it('reads a superseded but still-ready submission as "superseded", not "ready to compete"', async () => {
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submissions: [
        submission({ id: 'newer', status: 'ready' }),
        submission({
          id: 'older',
          status: 'ready',
          created_at: '2026-06-13T00:00:00Z',
          superseded_at: '2026-06-14T00:00:00Z',
        }),
      ],
    })

    // The current ready submission keeps the eligibility label...
    expect(await screen.findByText('ready to compete')).toBeInTheDocument()
    // ...while a once-ready submission that a newer one has replaced reads "superseded".
    expect(screen.getByText('superseded')).toBeInTheDocument()
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
    expect(screen.getByTestId('stage-detail-load')).toHaveTextContent(
      "Load check: no class named 'Agent'",
    )
  })

  it('shows the owner-only debug placeholder only to the agent owner', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
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
    // The placement's recording is reachable through a Replay link, as on the environment boards.
    expect(screen.getByRole('link', { name: 'Replay' })).toHaveAttribute('href', '/replays/rec-1')
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
    vi.mocked(getMe).mockResolvedValue(signedInMe('someone-else', 'normal'))
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [submission()] })
    expect(await screen.findByText(/Leaderboard Placements/)).toBeInTheDocument()
    expect(screen.queryByText(/LLM debug view/)).toBeNull()
  })

  it('prefills the submit form rating prompt for the open submission season', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
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

    // The prompt is now set from inside the submit form, keyed to the open submission season.
    await waitFor(() => expect(vi.mocked(getAuthorPrompt)).toHaveBeenCalledWith('iter-next'))
  })

  it('shows the owner the labelled current season, exact submission date, and failed status', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'iter-next',
        env_id: 'flappy_bird',
        submission_status: 'open',
        play_status: 'closed',
        release_status: 'unreleased',
        label: 'Week 4',
        created_at: '2026-06-10T00:00:00Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submission_season_id: 'iter-next',
      submissions: [
        submission({ id: 'current-failed', season_id: 'iter-next', status: 'load_failed' }),
        submission({ id: 'other-active', season_id: 'iter-old' }),
      ],
    })

    const seasonTag = await screen.findByText('Current Season: Week 4')
    expect(seasonTag).toBeInTheDocument()
    const currentSeasonHeader = document.getElementById('current-season-banner') as HTMLElement
    expect(currentSeasonHeader.tagName).toBe('HEADER')
    expect(currentSeasonHeader.closest('.ui-card')).toBeNull()
    expect(currentSeasonHeader.querySelector('.ui-card')).toBeNull()
    expect(screen.getAllByText('load check failed').length).toBeGreaterThan(0)
    expect(screen.queryByText('Not submitted')).toBeNull()
  })

  it('keeps the current season header useful when its metadata read fails', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    vi.mocked(listSeasons).mockRejectedValueOnce(new Error('metadata unavailable'))
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submission_season_id: 'iteration-123456',
      submissions: [],
    })

    expect(await screen.findByText('Current Season: Season iteratio')).toBeInTheDocument()
    expect(screen.getByText('Not submitted')).toBeInTheDocument()
  })

  it('shows the no-accepting-season state once instead of duplicating a closed-form notice', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [] })

    expect(
      await screen.findAllByText('No Season is accepting submissions right now.'),
    ).toHaveLength(1)
    expect(screen.queryByText(/Submissions are closed/)).toBeNull()
  })

  it('shows pending on acceptance and ready on settlement without re-handling the season query', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    const pendingSubmission = submission({
      id: 'new-sub',
      season_id: 'iter-next',
      status: 'pending',
    })
    const readySubmission = submission({
      id: 'new-sub',
      season_id: 'iter-next',
      status: 'ready',
    })
    let settleValidation: (detail: AgentProfileSubmission) => void = () => {}
    const terminalValidation = new Promise<AgentProfileSubmission>((resolve) => {
      settleValidation = resolve
    })

    try {
      await renderProfile(
        {
          env_id: 'flappy_bird',
          owner_id: 'eve',
          submission_season_id: 'iter-next',
          submissions: [],
        },
        '/environments/flappy_bird/agents/eve?season=iter-next',
      )
      const repository = await screen.findByLabelText('Repository URL')
      const header = document.getElementById('current-season-banner') as HTMLElement
      await waitFor(() => expect(document.activeElement).toBe(header))
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      repository.focus()
      expect(document.activeElement).toBe(repository)

      vi.mocked(checkReachability).mockResolvedValue({ reachable: true })
      vi.mocked(submitAgent).mockResolvedValue({ ok: true, id: 'new-sub', status: 'pending' })
      vi.mocked(getSubmission).mockReturnValue(terminalValidation)
      vi.mocked(getAgentProfile)
        .mockResolvedValueOnce({
          env_id: 'flappy_bird',
          owner_id: 'eve',
          submission_season_id: 'iter-next',
          play_season_id: null,
          author_prompts: {},
          submissions: [pendingSubmission],
        })
        .mockResolvedValueOnce({
          env_id: 'flappy_bird',
          owner_id: 'eve',
          submission_season_id: 'iter-next',
          play_season_id: null,
          author_prompts: {},
          submissions: [readySubmission],
        })

      await fireEvent.update(repository, 'https://example.test/new')
      await fireEvent.click(screen.getByRole('button', { name: 'Verify reachability' }))
      await screen.findByText('reachable')
      await fireEvent.click(screen.getByRole('button', { name: 'Submit agent' }))

      await waitFor(() => expect(within(header).getByText('pending')).toBeInTheDocument())
      expect(within(header).queryByText('Not submitted')).toBeNull()
      expect(scrollIntoView).toHaveBeenCalledTimes(1)

      settleValidation(readySubmission)
      await waitFor(() => expect(within(header).getByText('ready to compete')).toBeInTheDocument())
      expect(vi.mocked(getAgentProfile)).toHaveBeenCalledTimes(3)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(document.activeElement).not.toBe(header)
    } finally {
      if (originalScrollIntoView === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      } else {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView
      }
    }
  })

  it('reactively opens and focuses a season linked from My Agents', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    const { router } = await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submissions: [submission({ id: 'historical', season_id: 'iter-old' })],
    })
    const summary = await screen.findByRole('button', { expanded: true })
    await fireEvent.click(summary)
    expect(summary).toHaveAttribute('aria-expanded', 'false')

    await router.push('/environments/flappy_bird/agents/eve?season=iter-old')

    await waitFor(() => expect(summary).toHaveAttribute('aria-expanded', 'true'))
    expect(document.activeElement).toBe(document.getElementById('season-iter-old'))
  })

  it('focuses the current season header when the linked season has no submission', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    await renderProfile(
      {
        env_id: 'flappy_bird',
        owner_id: 'eve',
        submission_season_id: 'iter-next',
        submissions: [],
      },
      '/environments/flappy_bird/agents/eve?season=iter-next',
    )

    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById('current-season-banner')),
    )
  })

  it('focuses the current season header instead of its history group when it has a submission', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    await renderProfile(
      {
        env_id: 'flappy_bird',
        owner_id: 'eve',
        submission_season_id: 'iter-next',
        submissions: [submission({ id: 'current', season_id: 'iter-next' })],
      },
      '/environments/flappy_bird/agents/eve?season=iter-next',
    )

    await waitFor(() =>
      expect(document.activeElement).toBe(document.getElementById('current-season-banner')),
    )
    expect(document.activeElement).not.toBe(document.getElementById('season-iter-next'))
  })

  it('ignores an unknown season deep link', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'normal'))
    await renderProfile(
      {
        env_id: 'flappy_bird',
        owner_id: 'eve',
        submission_season_id: 'iter-next',
        submissions: [],
      },
      '/environments/flappy_bird/agents/eve?season=does-not-exist',
    )

    await screen.findByText('Not submitted')
    expect(document.activeElement).not.toBe(document.getElementById('current-season-banner'))
  })

  it('shows the owner rating prompt once per season in submission history', async () => {
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      author_prompts: { 'flappy_bird-iter-1': 'Reward smooth, human-like play.' },
      submissions: [
        submission({ id: 'a', status: 'ready' }),
        submission({ id: 'b', status: 'ready', superseded_at: '2026-06-14T01:00:00Z' }),
      ],
    })

    // One season group, two submissions, but the prompt line shows once for the group.
    const prompts = await screen.findAllByText(/Reward smooth, human-like play\./)
    expect(prompts).toHaveLength(1)
  })

  it('disables the submit form for a pending owner, showing the awaiting-approval notice', async () => {
    // A pending owner may look at their own profile but not submit (submit is requireActive), so the
    // form is replaced by the awaiting-approval message rather than an enabled control that 403s.
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'pending'))
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      submission_season_id: 'iter-next',
      submissions: [submission({ id: 'next', season_id: 'iter-next' })],
    })

    expect(await screen.findByText(/awaiting approval, so you can't submit/)).toBeInTheDocument()
    // The submit form itself is not rendered, so its repository field and submit button are absent.
    expect(screen.queryByRole('button', { name: 'Submit agent' })).toBeNull()
    expect(screen.queryByLabelText('Repository URL')).toBeNull()
    // ...and the owner-only prompt prefill never fires (the form never mounted).
    expect(vi.mocked(getAuthorPrompt)).not.toHaveBeenCalled()
  })

  it('shows an empty history for an owner with no submissions', async () => {
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'newbie', submissions: [] })
    expect(await screen.findByText(/has not submitted an agent/)).toBeInTheDocument()
  })

  it('prefers the profile owner_name over the owner id in the heading and empty state, once loaded', async () => {
    await renderProfile({
      env_id: 'flappy_bird',
      owner_id: 'eve',
      owner_name: 'Eve Adler',
      submissions: [],
    })
    // The heading shows the display name, but the stable route-param id remains reachable as a tooltip
    // (and stays the value profile links and ownership checks use, per isOwner()).
    const heading = await screen.findByRole('heading', {
      name: "Eve Adler's Submissions",
      level: 1,
    })
    expect(heading).toHaveAttribute('title', 'eve')
    // Same preference in the empty-history copy, with the id kept as its own tooltip.
    expect(screen.getByText('Eve Adler')).toHaveAttribute('title', 'eve')
    expect(screen.queryByText('eve', { exact: true })).toBeNull()
  })
})
