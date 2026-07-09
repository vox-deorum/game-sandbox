import { render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { flappyMeta } from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getEnvironments: vi.fn(),
}))

import { getEnvironments, getMe } from '../src/api/client.js'
import ExperimentTabs from '../src/components/ExperimentTabs.vue'
import { MeProvider } from '../src/me.js'

const META = flappyMeta()

// Mount the tab strip under the MeProvider on a router pushed to the given path, the way the shell
// wires it (the tabs read identity through useMe and resolve their targets from the :envId route).
async function renderTabs(path = '/environments/flappy_bird') {
  const router = memoryRouter([
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: { template: '<div />' } },
    { path: '/environments/:envId/replays', component: { template: '<div />' } },
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
  })

  it('shows the task tabs targeting the user, and hides Manage for a non-operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    await renderTabs()

    expect(await screen.findByRole('link', { name: 'Overview' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird',
    )
    expect(screen.getByRole('link', { name: 'Leaderboards' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/leaderboards',
    )
    expect(screen.getByRole('link', { name: 'Replays' })).toHaveAttribute(
      'href',
      '/environments/flappy_bird/replays',
    )
    // The agent tab reads "My Submissions" and targets the signed-in user's own agent page.
    const submit = await screen.findByRole('link', { name: 'My Submissions' })
    expect(submit).toHaveAttribute('href', '/environments/flappy_bird/agents/dev-user')
    expect(screen.queryByRole('link', { name: 'Manage' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Season' })).toBeNull()
  })

  it('targets the agent tab at the signed-in user and shows Manage for an operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('eve', 'admin'))
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

  it('hides the My Submissions tab for an anonymous visitor', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    await renderTabs()

    // The task tabs still render, but with no signed-in id there is no personal agent tab.
    expect(await screen.findByRole('link', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Leaderboards' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Replays' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'My Submissions' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Manage' })).toBeNull()
  })
})
