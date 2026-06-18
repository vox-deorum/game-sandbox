import { fireEvent, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { flappyMeta } from './helpers/fixtures.js'
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
  // The embedded SubmitAgentForm probes capabilities on mount and the WatchAgentPicker lists the
  // active ready agents; both default to empty here. The rest are unused in this suite.
  getSubmissionCapabilities: vi.fn().mockResolvedValue({ local_submissions: false }),
  listActiveSubmissions: vi.fn().mockResolvedValue([]),
  checkReachability: vi.fn(),
  submitAgent: vi.fn(),
  getSubmission: vi.fn(),
}))

import {
  getEnvironmentLeaderboards,
  getEnvironments,
  getMe,
  listRecordings,
  startSession,
} from '../src/api/client.js'
import EnvironmentPage from '../src/pages/EnvironmentPage.vue'

// A stub for the session route: this suite tests the environment page's navigation seam, not the
// session host, so the route only needs to surface the id it landed on.
const SessionStub = { template: '<div>{{ $route.params.id }}</div>' }

// Render the environment page (renderWithMe wires the MeProvider so the allowlist gate has its one
// /api/me fetch) on a router carrying the session route, so navigation on start lands on the stub.
async function renderPage() {
  const router = memoryRouter([
    // A home stub so the hub's "Environments / …" context-line link resolves in the test router.
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: EnvironmentPage },
    { path: '/environments/:envId/leaderboards/:iterationId?', component: { template: '<div />' } },
    { path: '/environments/:envId/admin', component: { template: '<div />' } },
    { path: '/sessions/:id', component: SessionStub },
  ])
  router.push('/environments/flappy_bird')
  await router.isReady()
  return renderWithMe(router)
}

describe('EnvironmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([META])
    vi.mocked(listRecordings).mockResolvedValue([])
    // Default: an iteration is play-open (so the watch/play entry points are enabled) but nothing is
    // released yet. Individual tests override this to exercise the closed-play and released states.
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: null,
      submission_iteration_id: 'iter-1',
      play_iteration_id: 'iter-1',
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

  it('disables watch and play when no iteration is play-open', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: null,
      submission_iteration_id: 'iter-1',
      play_iteration_id: null,
    })
    await renderPage()
    expect(await screen.findByText(/Public play is closed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play Yourself' })).toBeNull()
    // The submit form stays available even with play closed.
    expect(screen.getByRole('heading', { name: 'Submit an agent' })).toBeInTheDocument()
  })

  it('hides the submission form when no iteration is accepting submissions', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(getEnvironmentLeaderboards).mockResolvedValue({
      current: null,
      submission_iteration_id: null,
      play_iteration_id: 'iter-1',
    })
    await renderPage()
    expect(await screen.findByText(/Submissions are closed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify reachability' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Submit agent' })).toBeNull()
  })

  it('keeps the submit form available when the leaderboards read fails', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    // A transient failure must not read as "submissions closed": the form falls back to its own
    // status handling instead, while the play gate stays at its safe-closed default.
    vi.mocked(getEnvironmentLeaderboards).mockRejectedValue(new Error('network blip'))
    await renderPage()
    expect(await screen.findByRole('button', { name: 'Submit agent' })).toBeInTheDocument()
    expect(screen.queryByText(/Submissions are closed/)).toBeNull()
    expect(screen.queryByText(/Loading submission status/)).toBeNull()
    // Play stays closed when the read fails (the gate cannot confirm an open play target).
    expect(screen.getByText(/Public play is closed/)).toBeInTheDocument()
  })

  it('shows the operator admin entry point only to an operator', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: true,
    })
    await renderPage()
    const adminLink = await screen.findByRole('link', { name: 'Admin console' })
    expect(adminLink).toHaveAttribute('href', '/environments/flappy_bird/admin')
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
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      mode: 'human',
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
      mode: 'human',
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
})
