import { fireEvent, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { flappyMeta, heartsMeta } from './helpers/fixtures.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

const META = flappyMeta()

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
  listRecordings: vi.fn(),
  startSession: vi.fn(),
  getMe: vi.fn(),
  // The page fetches the environment leaderboards on mount for the boards embed and the watch/play
  // gate; default it to a play-open, nothing-released payload so the entry points stay enabled.
  getEnvironmentLeaderboards: vi.fn(),
  // The page also fetches the released-season record on mount for the "Past seasons" links; default
  // it to empty so the record stays hidden unless a test sets it.
  listReleasedSeasons: vi.fn().mockResolvedValue([]),
  // And the cross-game public seasons, to name the live play-open / submission-open seasons in the
  // header; default to empty so those badges stay off unless a test sets it.
  listSeasons: vi.fn().mockResolvedValue([]),
  // The WatchAgentPicker lists the active ready agents; default it to empty. Submission moved off the
  // hub to the Submit / My Agent tab (the agent profile), so the hub no longer mounts the submit form.
  listWatchAgents: vi.fn().mockResolvedValue([]),
}))

import {
  getEnvironmentLeaderboards,
  getEnvironments,
  getMe,
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
    vi.mocked(listRecordings).mockResolvedValue([])
    vi.mocked(listSeasons).mockResolvedValue([])
    // Default: a season is play-open (so the watch/play entry points are enabled) but nothing is
    // released yet. Individual tests override this to exercise the closed-play and released states.
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: null,
      submission_season_id: 'iter-1',
      play_season_id: 'iter-1',
    })
  })

  it('hides the play entry point for a non-allowlisted user', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'carol', allowlisted: false, is_operator: false })
    await renderPage()
    expect(await screen.findByText(/limited to allowlisted users/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play Yourself' })).toBeNull()
    // Watching moved to the picker, whose Watch buttons are likewise hidden when not allowlisted.
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
    // The operator-only admin entry point is hidden from a non-operator.
    expect(screen.queryByRole('link', { name: 'Admin console' })).toBeNull()
  })

  it('frames the watch section as "Rate an Agent" when there is an unrated agent', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    // An unrated agent the allowlisted viewer can rate flips the section heading from watch to rate.
    vi.mocked(listWatchAgents).mockResolvedValue([
      { submission_id: 'sub1', anonymous_number: 1, rating_status: 'unrated' },
    ])
    await renderPage()
    expect(
      await screen.findByRole('heading', { name: 'Rate an Agent', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Watch an Agent' })).toBeNull()
  })

  it('keeps the watch framing when there is nothing unrated to rate', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    // Only an already-rated agent: there is something to watch but nothing to rate.
    vi.mocked(listWatchAgents).mockResolvedValue([
      { submission_id: 'sub1', anonymous_number: 1, rating_status: 'rated' },
    ])
    await renderPage()
    expect(
      await screen.findByRole('heading', { name: 'Watch an Agent', level: 2 }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Rate an Agent' })).toBeNull()
  })

  it('disables watch and play when no season is play-open', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: null,
      submission_season_id: 'iter-1',
      play_season_id: null,
    })
    await renderPage()
    expect(await screen.findByText(/Public play is closed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play Yourself' })).toBeNull()
  })

  it('opens the play flow from the play-open season badge instead of linking to its boards', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(listSeasons).mockResolvedValue([
      {
        id: 'iter-1',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Week 1',
        created_at: '2026-06-10T00:00:00Z',
        released_at: null,
        submission_count: 0,
        session_count: 0,
      },
    ])
    await renderPage()

    const playable = await screen.findByRole('link', { name: 'Week 1: Playable' })
    expect(playable).toHaveAttribute('href', '/environments/flappy_bird?play=1')
    await fireEvent.click(playable)
    expect(await screen.findByRole('button', { name: 'Start playing' })).toBeInTheDocument()
  })

  it('keeps the hub stable when the leaderboards read fails (play stays safe-closed)', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    // A transient failure must not crash the hub; the play gate stays at its safe-closed default.
    vi.mocked(getEnvironmentLeaderboards).mockRejectedValue(new Error('network blip'))
    await renderPage()
    expect(await screen.findByText(/Public play is closed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play Yourself' })).toBeNull()
  })

  it('starts a session through the start form and navigates to it', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
    await renderPage()
    // The header's Play Yourself button opens the start form; submitting it starts the session.
    await fireEvent.click(await screen.findByRole('button', { name: 'Play Yourself' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Start playing' }))
    expect(await screen.findByText('s1')).toBeInTheDocument()
    // A single-slot environment fills only the lone human seat; the backend derives the human mode.
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      slots: { player_0: { kind: 'human' } },
      seed: undefined,
      humanSlotTimeoutMs: undefined,
    })
  })

  it('sends the human-slot timeout override entered in the start form', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
    await renderPage()
    await fireEvent.click(await screen.findByRole('button', { name: 'Play Yourself' }))
    // The paced game's start form exposes the per-step input window as an override field.
    await fireEvent.update(screen.getByPlaceholderText('50'), '250')
    await fireEvent.click(await screen.findByRole('button', { name: 'Start playing' }))
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      slots: { player_0: { kind: 'human' } },
      seed: undefined,
      humanSlotTimeoutMs: 250,
    })
  })

  it('navigates to the active session on an already-active start (rejoin)', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(startSession).mockResolvedValue({
      ok: false,
      reason: 'already_active',
      activeSessionId: 'active-9',
    })
    await renderPage()
    await fireEvent.click(await screen.findByRole('button', { name: 'Play Yourself' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Start playing' }))
    expect(await screen.findByText('active-9')).toBeInTheDocument()
  })

  it('opens the multi-seat play grid for Hearts and starts with one human seat', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getEnvironments).mockResolvedValue([heartsMeta()])
    // The multi-seat play dialog fetches the submitted-agent options for the non-human seats.
    vi.mocked(listWatchAgents).mockResolvedValue([])
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'h1', wsPath: '/api/sessions/h1/ws' },
    })
    await renderPage('hearts')
    await fireEvent.click(await screen.findByRole('button', { name: 'Play Yourself' }))
    // The seat grid opens with the human seated and the other seats defaulting to the Naive baseline.
    const start = await screen.findByRole('button', { name: 'Start playing' })
    expect(screen.getByText('You')).toBeInTheDocument()
    await fireEvent.click(start)
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'hearts',
      slots: {
        player_0: { kind: 'human' },
        player_1: { kind: 'builtin-agent' },
        player_2: { kind: 'builtin-agent' },
        player_3: { kind: 'builtin-agent' },
      },
      seed: undefined,
      humanSlotTimeoutMs: 60_000,
    })
    expect(await screen.findByText('h1')).toBeInTheDocument()
  })
})
