import { render, screen, waitFor } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { flappyMeta } from './helpers/fixtures.js'
import { memoryRouter } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getEnvironments: vi.fn(),
  listReleasedSeasons: vi.fn(),
}))

import { getEnvironments, getMe, listReleasedSeasons } from '../src/api/client.js'
import ExperimentTabs from '../src/components/ExperimentTabs.vue'
import { MeProvider } from '../src/me.js'

const META = flappyMeta()

// Mount the tab strip under the MeProvider on a router pushed to the given path, the way the shell
// wires it (the tabs read identity through useMe and resolve their targets from the :envId route).
async function renderTabs(path = '/environments/flappy_bird') {
  const router = memoryRouter([
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
    { path: '/environments/:envId/admin', component: { template: '<div />' } },
  ])
  router.push(path)
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(ExperimentTabs) },
    global: { plugins: [router] },
  })
}

describe('ExperimentTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([META])
    vi.mocked(listReleasedSeasons).mockResolvedValue([])
  })

  it('shows the task tabs targeting the user, and hides Manage for a non-operator', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    await renderTabs()

    expect(await screen.findByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird',
    )
    expect(screen.getByRole('link', { name: 'Leaderboards' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards',
    )
    // The agent tab reads "My Submissions" and targets the signed-in user's own agent page.
    const submit = await screen.findByRole('link', { name: 'My Submissions' })
    expect(submit).toHaveAttribute('href', '/environments/flappy_bird/agents/dev-user')
    expect(screen.queryByRole('link', { name: 'Manage' })).toBeNull()
  })

  it('targets the agent tab at the signed-in user and shows Manage for an operator', async () => {
    vi.mocked(getMe).mockResolvedValue({ user_id: 'eve', allowlisted: true, is_operator: true })
    await renderTabs()

    expect(await screen.findByRole('link', { name: 'My Submissions' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/agents/eve',
    )
    expect(screen.getByRole('link', { name: 'Manage' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/admin',
    )
  })

  it('lists released seasons in the switcher', async () => {
    vi.mocked(getMe).mockResolvedValue({
      user_id: 'dev-user',
      allowlisted: true,
      is_operator: false,
    })
    vi.mocked(listReleasedSeasons).mockResolvedValue([
      {
        id: 'iter-9',
        env_id: 'flappy_bird',
        submission_status: 'closed',
        play_status: 'closed',
        release_status: 'released',
        label: 'Season 2',
        config: { deps_version: 1, matches: [] },
        rating_prompt: null,
        created_at: '2026-06-14T00:00:00Z',
        released_at: '2026-06-15T00:00:00Z',
      },
    ])
    await renderTabs()

    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Season 2' })).toBeInTheDocument(),
    )
    expect(screen.getByRole('option', { name: 'Current' })).toBeInTheDocument()
  })
})
