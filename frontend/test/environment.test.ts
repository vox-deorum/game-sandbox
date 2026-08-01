import { fireEvent, screen } from '@testing-library/vue'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { flappyMeta, heartsMeta } from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

const META = flappyMeta()

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
  listRecordings: vi.fn(),
  startSession: vi.fn(),
  getMe: vi.fn(),
  // The page fetches the environment leaderboards on mount for the boards embed and the watch/play
  // boards embed; play gating is covered by the separate play-parameters mock.
  getEnvironmentLeaderboards: vi.fn(),
  getPlayParameters: vi.fn(),
  getSeasonSettings: vi.fn(),
  // The page also fetches the released-season record on mount for the "Past seasons" links; default
  // it to empty so the record stays hidden unless a test sets it.
  listReleasedSeasons: vi.fn().mockResolvedValue([]),
  // And the cross-game public seasons, to enrich the play banner and submission-open badge.
  listSeasons: vi.fn().mockResolvedValue([]),
  // The WatchAgentPicker lists the active ready agents; default it to empty. Submission moved off the
  // hub to the Submit / My Agent tab (the agent profile), so the hub no longer mounts the submit form.
  listWatchAgents: vi.fn().mockResolvedValue([]),
}))

import {
  getEnvironmentLeaderboards,
  getEnvironments,
  getMe,
  getPlayParameters,
  getSeasonSettings,
  listRecordings,
  listSeasons,
  listWatchAgents,
  startSession,
} from '../src/api/client.js'
import EnvironmentPage from '../src/pages/EnvironmentPage.vue'

// A stub for the session route: this suite tests the environment page's navigation seam, not the
// session host, so the route only needs to surface the id it landed on.
const SessionStub = { template: '<div>{{ $route.params.id }}</div>' }

// Render the environment page (renderWithMe wires the MeProvider so the allowlist gate has its one
// /api/me fetch) on a router carrying the session route, so navigation on start lands on the stub.
async function renderPage(envId = 'flappy_bird') {
  const router = memoryRouter([
    // A home stub so the hub's "Environments / …" context-line link resolves in the test router.
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: EnvironmentPage },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: { template: '<div />' } },
    { path: '/environments/:envId/admin', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div>login page</div>' } },
    { path: '/sessions/:id', component: SessionStub },
  ])
  router.push(`/environments/${envId}`)
  await router.isReady()
  return renderWithMe(router)
}

describe('EnvironmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([META])
    vi.mocked(getPlayParameters).mockResolvedValue({
      season_id: 'iter-1',
      values: { players: 1, pipe_gap: 100 },
    })
    vi.mocked(getSeasonSettings).mockResolvedValue({
      play: {
        season_id: 'iter-1',
        season_label: 'Playground',
        template_repo: { url: 'https://example.test/template', branch: 'main' },
        values: { players: 1, pipe_gap: 100 },
        rules: {
          step_timeout_ms: 1000,
          episode_timeout_ms: 120_000,
          messaging_enabled: false,
          message_cap: null,
          llm_enabled: false,
        },
      },
      submission: null,
    })
    vi.mocked(listRecordings).mockResolvedValue([])
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-10T00:00:00Z',
        released_at: null,
        submission_count: 0,
        game_count: 0,
      },
    ])
    // Default: a season is play-open (so the watch/play entry points are enabled) but nothing is
    // released yet. Individual tests override this to exercise the closed-play and released states.
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: null,
      submission_season_id: 'iter-1',
      play_season_id: 'iter-1',
    })
  })

  it('hides the play entry point for a still-pending user', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('carol', 'pending'))
    await renderPage()
    expect(await screen.findByText(/awaiting approval/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    // Watching moved to the picker, whose Watch buttons are likewise hidden when the account cannot participate.
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
    // The operator-only admin entry point is hidden from a non-operator.
    expect(screen.queryByRole('link', { name: 'Admin console' })).toBeNull()
  })

  it('keeps the play and watch entry points for an anonymous visitor and routes a click to sign-in', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    vi.mocked(listWatchAgents).mockResolvedValue([
      { submission_id: 'sub1', anonymous_number: 1, rating_status: 'unrated' },
    ])
    await renderPage()
    // Both entry points render signed-out; there is no separate sign-in prompt in the watch section.
    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rate' })).toBeInTheDocument()
    expect(screen.queryByText('Sign in to watch and rate agents.')).toBeNull()
    // Clicking one lands on the sign-in page instead of opening the start dialog.
    await fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(vi.mocked(startSession)).not.toHaveBeenCalled()
    expect(await screen.findByText('login page')).toBeInTheDocument()
  })

  it('shows no season changes when play uses the environment defaults', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    // The prefill resolves to the environment default, so the summary names the one visible parameter
    // (`players` is fixed at one for Flappy Bird and stays out of a player-facing line).
    await renderPage()
    expect(await screen.findByText('This season uses the default settings.')).toBeInTheDocument()
  })

  it('leaves the season settings block absent when its explanatory read fails', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    let rejectSettings!: (reason: unknown) => void
    vi.mocked(getSeasonSettings).mockReturnValue(
      new Promise<never>((_resolve, reject) => {
        rejectSettings = reject
      }),
    )
    await renderPage()

    await screen.findByRole('button', { name: 'Play' })
    await vi.waitFor(() => expect(getSeasonSettings).toHaveBeenCalledOnce())
    rejectSettings(new Error('settings unavailable'))
    await flushPromises()
    expect(screen.queryByRole('list', { name: 'Season changes' })).toBeNull()
    expect(screen.queryByText('This season uses the default settings.')).toBeNull()
  })

  it('leaves the season settings block absent when its response is for a stale play season', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getSeasonSettings).mockResolvedValue({
      play: {
        season_id: 'iter-0',
        season_label: 'Previous playground',
        template_repo: { url: 'https://example.test/template', branch: 'main' },
        values: { players: 1, pipe_gap: 90 },
        rules: {
          step_timeout_ms: 500,
          episode_timeout_ms: 60_000,
          messaging_enabled: false,
          message_cap: null,
          llm_enabled: false,
        },
      },
      submission: null,
    })
    await renderPage()

    await screen.findByRole('button', { name: 'Play' })
    await flushPromises()
    expect(screen.queryByRole('list', { name: 'Season changes' })).toBeNull()
    expect(screen.queryByText('This season uses the default settings.')).toBeNull()
  })

  it('lists play-season changes in declaration order', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getSeasonSettings).mockResolvedValue({
      play: {
        season_id: 'iter-1',
        season_label: 'Playground',
        template_repo: { url: 'https://example.test/template', branch: 'main' },
        values: { players: 1, pipe_gap: 90 },
        rules: {
          step_timeout_ms: 500,
          episode_timeout_ms: 60_000,
          messaging_enabled: false,
          message_cap: null,
          llm_enabled: false,
        },
      },
      submission: null,
    })
    await renderPage()
    const changes = await screen.findByRole('list', { name: 'Season changes' })
    expect(changes).toHaveTextContent('Pipe gap 100 → 90')
    expect(changes).toHaveTextContent('Decision limit 1 s → 0.5 s')
    expect(changes).toHaveTextContent('Game limit 120 s → 60 s')
  })

  it('names the released season in the boards heading with its release date beside it', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: {
        season: {
          id: 'iter-1',
          env_id: 'flappy_bird',
          submission_status: 'closed',
          play_status: 'closed',

          release_status: 'released',
          label: 'Partnership Cup',
          description_markdown: null,
          config: { deps_version: 1, matches: [] },
          rating_prompt: null,
          created_at: '2026-06-10T00:00:00Z',
          released_at: '2026-06-12T00:00:00Z',
        },
        board: { automated: [], human: [], games: [] },
      },
      submission_season_id: 'iter-1',
      play_season_id: 'iter-1',
    })
    await renderPage()
    expect(
      await screen.findByRole('heading', { name: 'Leaderboard: Partnership Cup', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.getByText(/^released /)).toBeInTheDocument()
  })

  it('names the play-open season in the season section and in the peer play heading', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-10T00:00:00Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    vi.mocked(listWatchAgents).mockResolvedValue([
      { submission_id: 'sub1', anonymous_number: 1, rating_status: 'unrated' },
    ])
    await renderPage()
    // The section the agents are listed in says which season they are played and rated under.
    expect(
      await screen.findByRole('heading', { name: 'Play and Rate: Playground', level: 2 }),
    ).toBeInTheDocument()
    // And the section above it names the same season as the one open for play.
    expect(
      screen.getByRole('heading', { name: 'Open for Play: Playground', level: 2 }),
    ).toBeInTheDocument()
  })

  it('tags the environment name with its seats and pace, and with no submission season', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    // A season taking submissions no longer adds a tag beside the name: the header carries only the
    // environment's own facts, which now sit on the title line rather than in a row of their own.
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'iter-1',
        env_id: 'flappy_bird',
        submission_status: 'open',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Playground',
        description_markdown: null,
        created_at: '2026-06-10T00:00:00Z',
        released_at: null,
        submission_count: 1,
        game_count: 0,
      },
    ])
    await renderPage()
    const title = await screen.findByRole('heading', { name: 'Flappy Bird', level: 1 })
    expect(title.parentElement).toHaveTextContent('1 seat')
    expect(title.parentElement).toHaveTextContent('paced 50 ms')
    expect(screen.queryByText(/Submittable/)).toBeNull()
  })

  it('disables watch and play when no season is play-open', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: null,
      submission_season_id: 'iter-1',
      play_season_id: null,
    })
    vi.mocked(getPlayParameters).mockResolvedValue({ season_id: null, values: {} })
    await renderPage()
    expect(await screen.findByText(/No season is currently open for play/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
  })

  it('opens the play flow from the play-season section', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Week 1',
        description_markdown: null,
        created_at: '2026-06-10T00:00:00Z',
        released_at: null,
        submission_count: 0,
        game_count: 0,
      },
    ])
    await renderPage()

    expect(
      await screen.findByRole('heading', { name: 'Open for Play: Week 1', level: 2 }),
    ).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(await screen.findByRole('button', { name: 'Start playing' })).toBeInTheDocument()
  })

  it('keeps the hub stable when the leaderboards read fails without closing confirmed play', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    // A transient boards failure affects only the released results embed.
    vi.mocked(getEnvironmentLeaderboards).mockRejectedValue(new Error('network blip'))
    await renderPage()
    expect(await screen.findByText(/No released results/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('keeps play and watch unavailable when the parameter prefill fails, and says so', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getPlayParameters).mockRejectedValue(new Error('prefill unavailable'))
    await renderPage()
    // A failed read is not the same fact as a closed play window; reporting it as one would tell the
    // viewer something about the season that the page never actually learned.
    expect(await screen.findByText(/play settings .* could not be loaded/i)).toBeInTheDocument()
    expect(screen.queryByText(/No season is currently open for play/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
  })

  it('reports a genuinely closed play window as closed', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getPlayParameters).mockResolvedValue({ season_id: null, values: {} })
    await renderPage()
    expect(await screen.findByText(/No season is currently open for play/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
  })

  it('starts a session through the start form and navigates to it', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
    await renderPage()
    // The play-season section's Play button opens the start form.
    await fireEvent.click(await screen.findByRole('button', { name: 'Play' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Start playing' }))
    expect(await screen.findByText('s1')).toBeInTheDocument()
    // A single-seat environment fills only the lone human seat; the backend derives the human mode.
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      seasonId: 'iter-1',
      parameters: { players: 1, pipe_gap: 100 },
      seats: { seat_0: { kind: 'human' } },
      seed: undefined,
      humanTimeoutMs: undefined,
    })
  })

  it('sends the human timeout override entered in the start form', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
    await renderPage()
    await fireEvent.click(await screen.findByRole('button', { name: 'Play' }))
    // The paced game's start form exposes the per-step input window as an override field.
    await fireEvent.update(screen.getByPlaceholderText('50'), '250')
    await fireEvent.click(await screen.findByRole('button', { name: 'Start playing' }))
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      seasonId: 'iter-1',
      parameters: { players: 1, pipe_gap: 100 },
      seats: { seat_0: { kind: 'human' } },
      seed: undefined,
      humanTimeoutMs: 250,
    })
  })

  it('shows a simultaneous input window without offering or submitting a human timeout override', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta({ stepping: 'simultaneous' })])
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
    await renderPage()
    await fireEvent.click(await screen.findByRole('button', { name: 'Play' }))

    expect(screen.getByText('Input window (ms)')).toBeInTheDocument()
    expect(screen.queryByRole('spinbutton', { name: 'Per-step input window (ms)' })).toBeNull()
    await fireEvent.click(await screen.findByRole('button', { name: 'Start playing' }))

    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      seasonId: 'iter-1',
      parameters: { players: 1, pipe_gap: 100 },
      seats: { seat_0: { kind: 'human' } },
      seed: undefined,
    })
  })

  it('navigates to the active session on an already-active start (rejoin)', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(startSession).mockResolvedValue({
      ok: false,
      reason: 'already_active',
      activeSessionId: 'active-9',
    })
    await renderPage()
    await fireEvent.click(await screen.findByRole('button', { name: 'Play' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Start playing' }))
    expect(await screen.findByText('active-9')).toBeInTheDocument()
  })

  it('opens the multi-seat play grid for Hearts and starts with one human seat', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getEnvironments).mockResolvedValue([heartsMeta()])
    vi.mocked(getPlayParameters).mockResolvedValue({
      season_id: 'iter-1',
      values: { players: 4 },
    })
    // The multi-seat play dialog fetches the submitted-agent options for the non-human seats.
    vi.mocked(listWatchAgents).mockResolvedValue([])
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'h1', wsPath: '/api/sessions/h1/ws' },
    })
    await renderPage('hearts')
    await fireEvent.click(await screen.findByRole('button', { name: 'Play' }))
    // The seat grid opens with the human seated and the other seats defaulting to the Naive baseline.
    const start = await screen.findByRole('button', { name: 'Start playing' })
    expect(screen.getByText('You')).toBeInTheDocument()
    await fireEvent.click(start)
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'hearts',
      seasonId: 'iter-1',
      parameters: { players: 4 },
      seats: {
        seat_0: { kind: 'human' },
        seat_1: { kind: 'builtin-agent', name: 'naive' },
        seat_2: { kind: 'builtin-agent', name: 'naive' },
        seat_3: { kind: 'builtin-agent', name: 'naive' },
      },
      seed: undefined,
      humanTimeoutMs: 60_000,
    })
    expect(await screen.findByText('h1')).toBeInTheDocument()
  })
})
