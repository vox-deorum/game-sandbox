import { screen, within } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentProfile, AgentProfileSubmission, SubmissionCheck } from '../src/api/client.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getAgentProfile: vi.fn(),
  // The owner-only author-prompt editor self-fetches on mount; default it to an unset prompt.
  getAuthorPrompt: vi.fn(async () => ({ iteration_id: 'flappy_bird-iter-1', prompt: null })),
  setAuthorPrompt: vi.fn(async () => ({ ok: true, prompt: null })),
}))

import { getAgentProfile, getMe } from '../src/api/client.js'
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
    checks: [],
    replays: [],
    ...overrides,
  }
}

async function renderProfile(profile: AgentProfile) {
  vi.mocked(getAgentProfile).mockResolvedValue(profile)
  const router = memoryRouter([
    // Stubs for the breadcrumb links so the context-line RouterLinks resolve in the test router.
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: AgentProfilePage },
    { path: '/replays/:id', component: ReplayStub },
  ])
  router.push('/environments/flappy_bird/agents/eve')
  await router.isReady()
  return renderWithMe(router)
}

describe('AgentProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
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

    expect(await screen.findByRole('heading', { name: 'eve', level: 1 })).toBeInTheDocument()
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
    vi.mocked(getMe).mockResolvedValue({ user_id: 'eve', allowlisted: true })
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [submission()] })
    expect(await screen.findByText(/LLM debug view/)).toBeInTheDocument()
    // The leaderboard placeholder is visible to everyone, inert.
    expect(screen.getByText(/Leaderboard placements/)).toBeInTheDocument()
  })

  it('hides the owner-only debug placeholder from a non-owner viewer', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'someone-else', allowlisted: true })
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'eve', submissions: [submission()] })
    expect(await screen.findByText(/Leaderboard placements/)).toBeInTheDocument()
    expect(screen.queryByText(/LLM debug view/)).toBeNull()
  })

  it('shows an empty history for an owner with no submissions', async () => {
    await renderProfile({ env_id: 'flappy_bird', owner_id: 'newbie', submissions: [] })
    expect(await screen.findByText(/has not submitted an agent/)).toBeInTheDocument()
  })
})
