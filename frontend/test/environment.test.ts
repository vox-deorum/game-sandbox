import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { fireEvent, render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'

const META: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: 'A paced single-human clone.',
  min_slots: 1,
  max_slots: 1,
  human_slots: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
  step_limit_ms: 1000,
  episode_limit_ms: 120_000,
  messaging: false,
  message_cap: null,
  llm: false,
  renderer: 'flappy-bird',
}

vi.mock('../src/api/client.js', () => ({
  getEnvironments: vi.fn(),
  listRecordings: vi.fn(),
  startSession: vi.fn(),
  getMe: vi.fn(),
}))

import { getEnvironments, getMe, listRecordings, startSession } from '../src/api/client.js'
import { MeProvider } from '../src/me.js'
import EnvironmentPage from '../src/pages/EnvironmentPage.vue'

// A stub for the session route: this suite tests the environment page's navigation seam, not the
// session host, so the route only needs to surface the id it landed on.
const SessionStub = { template: '<div>{{ $route.params.id }}</div>' }

// Render the environment page inside the me provider (so the allowlist gate has its one /api/me fetch)
// and a real router carrying the session route, so navigation on start lands on the stub.
async function renderPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      // A home stub so the hub's "Environments / …" context-line link resolves in the test router.
      { path: '/', component: { template: '<div />' } },
      { path: '/environments/:envId', component: EnvironmentPage },
      { path: '/sessions/:id', component: SessionStub },
    ],
  })
  router.push('/environments/flappy_bird')
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(RouterView) },
    global: { plugins: [router] },
  })
}

describe('EnvironmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([META])
    vi.mocked(listRecordings).mockResolvedValue([])
  })

  it('hides the play and watch entry points for a non-allowlisted user', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'carol', allowlisted: false })
    await renderPage()
    expect(await screen.findByText(/limited to allowlisted users/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
  })

  it('starts a session through the start form and navigates to it', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
    await renderPage()
    // The entry point opens the start form; submitting it starts the session.
    await fireEvent.click(await screen.findByRole('button', { name: 'Watch' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Start watching' }))
    expect(await screen.findByText('s1')).toBeInTheDocument()
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({
      envId: 'flappy_bird',
      mode: 'scripted',
      seed: undefined,
      humanSlotTimeoutMs: undefined,
    })
  })

  it('sends the human-slot timeout override entered in the start form', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
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
      mode: 'human',
      seed: undefined,
      humanSlotTimeoutMs: 250,
    })
  })

  it('navigates to the active session on an already-active start (rejoin)', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
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
})
