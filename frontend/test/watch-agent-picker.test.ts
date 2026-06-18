import { fireEvent, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SubmissionSummary } from '../src/api/client.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  listActiveSubmissions: vi.fn(),
  startSession: vi.fn(),
}))

import { getMe, listActiveSubmissions, startSession } from '../src/api/client.js'
import WatchAgentPicker from '../src/components/WatchAgentPicker.vue'

const SessionStub = { template: '<div>session {{ $route.params.id }}</div>' }
const ProfileStub = { template: '<div>profile {{ $route.params.ownerId }}</div>' }

function summary(overrides: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: 'sub1',
    iteration_id: 'flappy_bird-iter-1',
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

  it('requests only the active ready submissions and lists them', async () => {
    vi.mocked(listActiveSubmissions).mockResolvedValue([summary()])
    await renderPicker()
    expect(await screen.findByText('eve')).toBeInTheDocument()
    // The pinned commit is shown short; the picker asked for the ready set only.
    expect(screen.getByText('abcdef1234')).toBeInTheDocument()
    expect(vi.mocked(listActiveSubmissions)).toHaveBeenCalledWith('flappy_bird', {
      status: 'ready',
    })
  })

  it('shows an empty state when no agent is ready', async () => {
    vi.mocked(listActiveSubmissions).mockResolvedValue([])
    await renderPicker()
    expect(await screen.findByText(/No submitted agents are ready/)).toBeInTheDocument()
  })

  it('starts a submitted-agent watch run and navigates to the session', async () => {
    vi.mocked(listActiveSubmissions).mockResolvedValue([summary()])
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 'sess-9', wsPath: '/api/sessions/sess-9/ws' },
    })
    await renderPicker()
    // The first Watch button is the pinned built-in row; the submitted agent's is the second.
    const watchButtons = await screen.findAllByRole('button', { name: 'Watch' })
    await fireEvent.click(watchButtons[1] as HTMLElement)
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      mode: 'scripted',
      submissionId: 'sub1',
    })
    expect(await screen.findByText('session sess-9')).toBeInTheDocument()
  })

  it('pins the built-in Naive agent and watches it with no submission', async () => {
    vi.mocked(listActiveSubmissions).mockResolvedValue([])
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

  it('hides the Watch action for a non-allowlisted viewer but still lists agents', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'carol', allowlisted: false, is_operator: false })
    vi.mocked(listActiveSubmissions).mockResolvedValue([summary()])
    await renderPicker()
    expect(await screen.findByText('eve')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
    expect(screen.getByText(/limited to allowlisted users/)).toBeInTheDocument()
  })

  it('links each agent to its owner profile', async () => {
    vi.mocked(listActiveSubmissions).mockResolvedValue([summary()])
    await renderPicker()
    const link = await screen.findByRole('link', { name: 'eve' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/agents/eve')
  })
})
