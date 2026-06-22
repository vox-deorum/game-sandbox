import { fireEvent, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { WatchAgentSummary } from '../src/api/client.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  listWatchAgents: vi.fn(),
  startSession: vi.fn(),
}))

import { getMe, listWatchAgents, startSession } from '../src/api/client.js'
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

async function renderPicker() {
  const router = memoryRouter([
    { path: '/environments/:envId', component: WatchAgentPicker, props: { envId: 'flappy_bird' } },
    { path: '/sessions/:id', component: SessionStub },
    { path: '/environments/:envId/agents/:ownerId', component: ProfileStub },
  ])
  router.push('/environments/flappy_bird')
  await router.isReady()
  return renderWithMe(router)
}

describe('WatchAgentPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
  })

  it('lists an anonymous unrated agent with a highlighted Rate action', async () => {
    vi.mocked(listWatchAgents).mockResolvedValue([summary()])
    await renderPicker()
    expect(await screen.findByText('Submitted agent 1')).toBeInTheDocument()
    expect(screen.getByText('Not rated')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rate' })).toHaveClass('primary')
    expect(vi.mocked(listWatchAgents)).toHaveBeenCalledWith('flappy_bird')
  })

  it('shows an empty state when no agent is ready', async () => {
    vi.mocked(listWatchAgents).mockResolvedValue([])
    await renderPicker()
    expect(await screen.findByText(/No submitted agents are ready/)).toBeInTheDocument()
  })

  it('starts a submitted-agent watch run and navigates to the session', async () => {
    vi.mocked(listWatchAgents).mockResolvedValue([summary()])
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-9', wsPath: '/api/sessions/sess-9/ws' },
    })
    await renderPicker()
    await fireEvent.click(await screen.findByRole('button', { name: 'Rate' }))
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      mode: 'scripted',
      submissionId: 'sub1',
    })
    expect(await screen.findByText('session sess-9')).toBeInTheDocument()
  })

  it('pins the built-in Naive agent and watches it with no submission', async () => {
    vi.mocked(listWatchAgents).mockResolvedValue([])
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-naive', wsPath: '/api/sessions/sess-naive/ws' },
    })
    await renderPicker()
    expect(await screen.findByText('Naive agent')).toBeInTheDocument()
    // The built-in row is the only one here, so its Watch button is the first (and only) one.
    await fireEvent.click(await screen.findByRole('button', { name: 'Watch' }))
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      mode: 'scripted',
      submissionId: undefined,
    })
    expect(await screen.findByText('session sess-naive')).toBeInTheDocument()
  })

  it('hides actions for a non-allowlisted viewer but still lists anonymous agents', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'carol', allowlisted: false, is_operator: false })
    vi.mocked(listWatchAgents).mockResolvedValue([summary()])
    await renderPicker()
    expect(await screen.findByText('Submitted agent 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Rate' })).toBeNull()
    expect(screen.getByText(/limited to allowlisted users/)).toBeInTheDocument()
  })

  it('shows rated and owned agents as secondary Watch again actions', async () => {
    vi.mocked(listWatchAgents).mockResolvedValue([
      summary({ rating_status: 'rated' }),
      summary({ submission_id: 'sub2', anonymous_number: 2, rating_status: 'own' }),
    ])
    await renderPicker()
    expect(await screen.findByText('Rated')).toBeInTheDocument()
    expect(screen.getByText('Your agent')).toBeInTheDocument()
    const actions = screen.getAllByRole('button', { name: 'Watch again' })
    expect(actions).toHaveLength(2)
    for (const action of actions) {
      expect(action).toHaveClass('secondary')
    }
  })

  it('shows operator-only owner and source details with a profile link', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: true,
    })
    vi.mocked(listWatchAgents).mockResolvedValue([
      summary({
        owner_id: 'eve',
        source_kind: 'git',
        commit_sha: 'abcdef1234567890',
        repo_url: 'https://example.test/agent',
      }),
    ])
    await renderPicker()
    const link = await screen.findByRole('link', { name: 'eve' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/agents/eve')
    expect(screen.getByText('abcdef1234')).toBeInTheDocument()
  })
})
