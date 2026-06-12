import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { EnvironmentPage } from '../src/pages/environment.js'
import { SessionPage } from '../src/pages/session.js'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/environments/flappy_bird']}>
      <MeProvider>
        <Routes>
          <Route path="/environments/:envId" element={<EnvironmentPage />} />
          <Route path="/sessions/:id" element={<SessionPage />} />
        </Routes>
      </MeProvider>
    </MemoryRouter>,
  )
}

describe('EnvironmentPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([META])
    vi.mocked(listRecordings).mockResolvedValue([])
  })

  it('hides the play and watch entry points for a non-allowlisted user', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'carol', allowlisted: false })
    renderPage()
    expect(await screen.findByText(/limited to allowlisted users/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull()
  })

  it('starts a session and navigates to it for an allowlisted user', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
    vi.mocked(startSession).mockResolvedValue({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }))
    expect(await screen.findByText('s1')).toBeInTheDocument()
    expect(vi.mocked(startSession)).toHaveBeenCalledWith({ envId: 'flappy_bird', mode: 'scripted' })
  })

  it('navigates to the active session on an already-active start (rejoin)', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'dev-user', allowlisted: true })
    vi.mocked(startSession).mockResolvedValue({
      ok: false,
      reason: 'already_active',
      activeSessionId: 'active-9',
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Play' }))
    expect(await screen.findByText('active-9')).toBeInTheDocument()
  })
})
