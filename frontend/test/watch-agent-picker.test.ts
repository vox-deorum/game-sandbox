import type { EnvironmentMeta, ParameterValue } from '@game-sandbox/schema/environment'
import { fireEvent, screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StartSessionResult, WatchAgentSummary } from '../src/api/client.js'
import { flappyMeta, heartsMeta, spadesMeta } from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
}))

import { getMe, startSession, stopSession } from '../src/api/client.js'
import WatchAgentPicker from '../src/components/WatchAgentPicker.vue'

const SessionStub = { template: '<div>session {{ $route.params.id }}</div>' }
const ProfileStub = { template: '<div>profile {{ $route.params.ownerId }}</div>' }

function summary(overrides: Partial<WatchAgentSummary> = {}): WatchAgentSummary {
  return {
    submission_id: 'sub1',
    anonymous_number: 1,
    rating_status: 'unrated',
    ...overrides,
  }
}

async function renderPicker(
  meta: EnvironmentMeta = flappyMeta(),
  agents: WatchAgentSummary[] = [],
  parameters: Record<string, ParameterValue> = Object.fromEntries(
    meta.parameters.map((parameter) => [parameter.name, parameter.default]),
  ),
) {
  const router = memoryRouter([
    {
      path: '/environments/:envId',
      component: WatchAgentPicker,
      props: { envId: meta.env_id, meta, agents, seasonId: 'season-1', parameters },
    },
    { path: '/sessions/:id', component: SessionStub },
    { path: '/environments/:envId/agents/:ownerId', component: ProfileStub },
    { path: '/login', component: { template: '<div>login page</div>' } },
  ])
  router.push(`/environments/${meta.env_id}`)
  await router.isReady()
  return renderWithMe(router)
}

describe('WatchAgentPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
  })

  it('lists an anonymous unrated agent with a highlighted Rate action', async () => {
    await renderPicker(flappyMeta(), [summary()])
    await screen.findByText('Agent 1')
    expect(screen.getByText('Not rated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rate' })).toHaveClass('primary')
  })

  it('shows an empty state when no agent is ready', async () => {
    await renderPicker(flappyMeta(), [])
    await screen.findByText(/No submitted agents are ready/)
  })

  it('starts a submitted-agent watch run and navigates to the session', async () => {
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-9', wsPath: '/api/sessions/sess-9/ws' },
    })
    await renderPicker(flappyMeta(), [summary()])
    await fireEvent.click(await screen.findByRole('button', { name: 'Rate' }))
    expect(vi.mocked(startSession)).not.toHaveBeenCalled()
    expect(screen.getByRole('spinbutton', { name: 'Pipe gap' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Seat 1' })).toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Seed (optional)' })).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Start watching' }))
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      seasonId: 'season-1',
      parameters: { players: 1, pipe_gap: 100 },
      seats: { seat_0: { kind: 'submission', submissionId: 'sub1' } },
      seed: undefined,
      humanTimeoutMs: undefined,
    })
    await screen.findByText('session sess-9')
  })

  it('pins the built-in Naive agent and watches it with no submission', async () => {
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-naive', wsPath: '/api/sessions/sess-naive/ws' },
    })
    await renderPicker(flappyMeta(), [])
    await screen.findByText('Naive agent')
    // The built-in row is the only one here, so its Watch button is the first (and only) one.
    const watchButton = await screen.findByRole('button', { name: 'Watch' })
    // Watching is the non-primary action: only Rate is highlighted, so this stays secondary.
    expect(watchButton).toHaveClass('secondary')
    await fireEvent.click(watchButton)
    await fireEvent.click(screen.getByRole('button', { name: 'Start watching' }))
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      seasonId: 'season-1',
      parameters: { players: 1, pipe_gap: 100 },
      seats: { seat_0: { kind: 'builtin-agent', name: 'naive' } },
      seed: undefined,
      humanTimeoutMs: undefined,
    })
    await screen.findByText('session sess-naive')
  })

  it('replaces an active session before retrying a direct fixed single-seat watch', async () => {
    const fixedMeta = flappyMeta({
      parameters: flappyMeta().parameters.filter((parameter) => parameter.name === 'players'),
    })
    vi.mocked(startSession)
      .mockResolvedValueOnce({ ok: false, reason: 'already_active', activeSessionId: 'active-9' })
      .mockResolvedValueOnce({
        ok: true,
        session: { id: 'new-direct', wsPath: '/api/sessions/new-direct/ws' },
      })
    await renderPicker(fixedMeta, [], { players: 1 })
    await fireEvent.click(await screen.findByRole('button', { name: 'Watch' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('A session is already running')
    expect(vi.mocked(stopSession)).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: 'Start new' }))
    await screen.findByText('session new-direct')
    expect(vi.mocked(stopSession)).toHaveBeenCalledWith('active-9')
    expect(vi.mocked(startSession)).toHaveBeenNthCalledWith(2, {
      envId: 'flappy_bird',
      seasonId: 'season-1',
      parameters: { players: 1 },
      seats: { seat_0: { kind: 'builtin-agent', name: 'naive' } },
    })
  })

  it('lists every declared builtin and preselects the clicked builtin by name', async () => {
    await renderPicker(spadesMeta(), [])
    const naiveRow = screen
      .getByText('Naive agent', { selector: '.agent-name' })
      .closest('.agent-row') as HTMLElement
    await fireEvent.click(within(naiveRow).getByRole('button', { name: 'Watch' }))
    expect(screen.getByRole('combobox', { name: 'Seat 1' })).toHaveValue('builtin:naive')
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const cautiousRow = screen
      .getByText('Cautious bidder', { selector: '.agent-name' })
      .closest('.agent-row') as HTMLElement
    await fireEvent.click(cautiousRow.querySelector('button') as HTMLButtonElement)
    expect(screen.getByRole('combobox', { name: 'Seat 1' })).toHaveValue('builtin:cautious')
    expect(screen.getByRole('combobox', { name: 'Seat 2' })).toHaveValue('builtin:cautious')
  })

  it('hides actions for a still-pending viewer but still lists anonymous agents', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('carol', 'pending'))
    await renderPicker(flappyMeta(), [summary()])
    await screen.findByText('Agent 1')
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rate' })).toBeNull()
    // A signed-in but unapproved account sees the awaiting-approval copy, not a sign-in prompt.
    expect(screen.getByText(/awaiting approval/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
  })

  it('keeps the watch actions for an anonymous viewer and routes a click to the sign-in page', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    await renderPicker(flappyMeta(), [summary()])
    // The list renders with its actions and no separate sign-in prompt; the actions themselves are
    // the entry point into signing in.
    await screen.findByText('Agent 1')
    expect(screen.queryByText('Sign in to watch and rate agents.')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Rate' }))
    // No run starts without an account: the click lands on the sign-in page instead.
    expect(vi.mocked(startSession)).not.toHaveBeenCalled()
    await screen.findByText('login page')
  })

  it('shows rated and owned agents as secondary Watch again actions', async () => {
    await renderPicker(flappyMeta(), [
      summary({ rating_status: 'rated' }),
      summary({ submission_id: 'sub2', anonymous_number: 2, rating_status: 'own' }),
    ])
    await screen.findByText('Rated')
    expect(screen.getByText('Your agent')).toBeInTheDocument()
    const actions = screen.getAllByRole('button', { name: 'Watch again' })
    expect(actions).toHaveLength(2)
    for (const action of actions) {
      expect(action).toHaveClass('secondary')
    }
  })

  it('keeps configuration editable when watching a rated agent again', async () => {
    await renderPicker(flappyMeta(), [summary({ rating_status: 'rated' })])
    await fireEvent.click(await screen.findByRole('button', { name: 'Watch again' }))

    expect(screen.getByRole('spinbutton', { name: 'Pipe gap' })).not.toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Seat 1' })).not.toBeDisabled()
    expect(screen.getByRole('spinbutton', { name: 'Seed (optional)' })).not.toBeDisabled()
  })

  it('opens the watch dialog with the clicked agent preselected for a multi-seat environment', async () => {
    let resolveStart!: (result: StartSessionResult) => void
    vi.mocked(startSession).mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve
      }),
    )
    await renderPicker(heartsMeta(), [summary()])
    // Clicking a row in a multi-seat environment opens the seat dialog instead of starting at once.
    await fireEvent.click(await screen.findByRole('button', { name: 'Rate' }))
    expect(vi.mocked(startSession)).not.toHaveBeenCalled()
    // Every one of the four seats is preselected to the clicked submitted agent (prefill-all).
    const seats = ['Seat 1', 'Seat 2', 'Seat 3', 'Seat 4'].map(
      (name) => screen.getByRole('combobox', { name }) as HTMLSelectElement,
    )
    for (const seat of seats) {
      expect(seat.value).toBe('submission:sub1')
      expect(seat).toBeDisabled()
    }
    // Starting from the dialog sends the full four-seat assignment and navigates to the session.
    const start = screen.getByRole('button', { name: 'Start watching' })
    await fireEvent.click(start)
    expect(start).toBeDisabled()
    expect(start).toHaveAttribute('aria-busy', 'true')
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'hearts',
      seasonId: 'season-1',
      parameters: { players: 4 },
      seats: {
        seat_0: { kind: 'submission', submissionId: 'sub1' },
        seat_1: { kind: 'submission', submissionId: 'sub1' },
        seat_2: { kind: 'submission', submissionId: 'sub1' },
        seat_3: { kind: 'submission', submissionId: 'sub1' },
      },
      seed: undefined,
    })
    resolveStart({
      ok: true,
      session: { id: 'sess-hearts', wsPath: '/api/sessions/sess-hearts/ws' },
    })
    await screen.findByText('session sess-hearts')
  })

  it('returns to the active session from a configured rating start without stopping it', async () => {
    vi.mocked(startSession).mockResolvedValue({
      ok: false,
      reason: 'already_active',
      activeSessionId: 'active-rate',
    })
    await renderPicker(heartsMeta(), [summary()])
    await fireEvent.click(await screen.findByRole('button', { name: 'Rate' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Start watching' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Return' }))
    await screen.findByText('session active-rate')
    expect(vi.mocked(stopSession)).not.toHaveBeenCalled()
  })

  it('keeps a failed configured start open and shows its error', async () => {
    vi.mocked(startSession).mockResolvedValue({
      ok: false,
      reason: 'failed',
      status: 500,
      message: 'Session launch failed.',
    })
    await renderPicker(heartsMeta(), [summary()])
    await fireEvent.click(await screen.findByRole('button', { name: 'Rate' }))
    const start = screen.getByRole('button', { name: 'Start watching' })

    await fireEvent.click(start)

    const error = await screen.findByText('Session launch failed.')
    expect(error).toHaveAttribute('role', 'alert')
    expect(start).toBeEnabled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('shows operator-only owner and source details with a profile link, falling back to the id', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    await renderPicker(flappyMeta(), [
      summary({
        owner_id: 'eve',
        source_kind: 'git',
        commit_sha: 'abcdef1234567890',
        repo_url: 'https://example.test/agent',
      }),
    ])
    // No owner_name on this row, so the link text falls back to the stable id — which is also the link
    // target and, redundantly, its own tooltip.
    const link = await screen.findByRole('link', { name: 'eve' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/agents/eve')
    expect(link).toHaveAttribute('title', 'eve')
    expect(screen.getByText('abcdef1234')).toBeInTheDocument()
  })

  it('prefers owner_name over the owner id for the operator profile-link text, keeping the id for the link and tooltip', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    await renderPicker(flappyMeta(), [
      summary({
        owner_id: 'eve',
        owner_name: 'Eve Adler',
        source_kind: 'git',
        commit_sha: 'abcdef1234567890',
        repo_url: 'https://example.test/agent',
      }),
    ])
    const link = await screen.findByRole('link', { name: 'Eve Adler' })
    // The link path and tooltip both stay keyed on the stable id, never the display name.
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/agents/eve')
    expect(link).toHaveAttribute('title', 'eve')
    expect(screen.queryByText('eve', { exact: true })).toBeNull()
  })
})
