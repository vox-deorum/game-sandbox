import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { fireEvent, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WatchAgentSummary } from '../src/api/client.js'
import { flappyMeta, heartsMeta } from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  startSession: vi.fn(),
}))

import { getMe, startSession } from '../src/api/client.js'
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
) {
  const router = memoryRouter([
    {
      path: '/environments/:envId',
      component: WatchAgentPicker,
      props: { envId: meta.env_id, meta, agents },
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
    expect(await screen.findByText('Submitted agent 1')).toBeInTheDocument()
    expect(screen.getByText('Not rated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rate' })).toHaveClass('primary')
  })

  it('shows an empty state when no agent is ready', async () => {
    await renderPicker(flappyMeta(), [])
    expect(await screen.findByText(/No submitted agents are ready/)).toBeInTheDocument()
  })

  it('starts a submitted-agent watch run and navigates to the session', async () => {
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-9', wsPath: '/api/sessions/sess-9/ws' },
    })
    await renderPicker(flappyMeta(), [summary()])
    await fireEvent.click(await screen.findByRole('button', { name: 'Rate' }))
    // A single-slot environment skips the seat dialog and starts the one-seat assignment immediately.
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      slots: { player_0: { kind: 'submission', submissionId: 'sub1' } },
      seed: undefined,
    })
    expect(await screen.findByText('session sess-9')).toBeInTheDocument()
  })

  it('pins the built-in Naive agent and watches it with no submission', async () => {
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-naive', wsPath: '/api/sessions/sess-naive/ws' },
    })
    await renderPicker(flappyMeta(), [])
    expect(await screen.findByText('Naive agent')).toBeInTheDocument()
    // The built-in row is the only one here, so its Watch button is the first (and only) one.
    const watchButton = await screen.findByRole('button', { name: 'Watch' })
    // Watching is the non-primary action: only Rate is highlighted, so this stays secondary.
    expect(watchButton).toHaveClass('secondary')
    await fireEvent.click(watchButton)
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      slots: { player_0: { kind: 'builtin-agent' } },
      seed: undefined,
    })
    expect(await screen.findByText('session sess-naive')).toBeInTheDocument()
  })

  it('hides actions for a still-pending viewer but still lists anonymous agents', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('carol', 'pending'))
    await renderPicker(flappyMeta(), [summary()])
    expect(await screen.findByText('Submitted agent 1')).toBeInTheDocument()
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
    expect(await screen.findByText('Submitted agent 1')).toBeInTheDocument()
    expect(screen.queryByText('Sign in to watch and rate agents.')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Rate' }))
    // No run starts without an account: the click lands on the sign-in page instead.
    expect(vi.mocked(startSession)).not.toHaveBeenCalled()
    expect(await screen.findByText('login page')).toBeInTheDocument()
  })

  it('shows rated and owned agents as secondary Watch again actions', async () => {
    await renderPicker(flappyMeta(), [
      summary({ rating_status: 'rated' }),
      summary({ submission_id: 'sub2', anonymous_number: 2, rating_status: 'own' }),
    ])
    expect(await screen.findByText('Rated')).toBeInTheDocument()
    expect(screen.getByText('Your agent')).toBeInTheDocument()
    const actions = screen.getAllByRole('button', { name: 'Watch again' })
    expect(actions).toHaveLength(2)
    for (const action of actions) {
      expect(action).toHaveClass('secondary')
    }
  })

  it('opens the watch dialog with the clicked agent preselected for a multi-seat environment', async () => {
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-hearts', wsPath: '/api/sessions/sess-hearts/ws' },
    })
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
    }
    // Starting from the dialog sends the full four-seat slots assignment and navigates to the session.
    await fireEvent.click(screen.getByRole('button', { name: 'Start watching' }))
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'hearts',
      slots: {
        player_0: { kind: 'submission', submissionId: 'sub1' },
        player_1: { kind: 'submission', submissionId: 'sub1' },
        player_2: { kind: 'submission', submissionId: 'sub1' },
        player_3: { kind: 'submission', submissionId: 'sub1' },
      },
      seed: undefined,
    })
    expect(await screen.findByText('session sess-hearts')).toBeInTheDocument()
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
