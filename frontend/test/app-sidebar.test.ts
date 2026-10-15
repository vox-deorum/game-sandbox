import { render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

// The account block reads /api/me through the MeProvider; mock it so each test controls the session.
vi.mock('../src/api/client.js', () => ({ getMe: vi.fn() }))

import { getMe } from '../src/api/client.js'
import AppSidebar from '../src/components/AppSidebar.vue'
import { MeProvider } from '../src/me.js'
import { anonymousMe, signedInMe } from './helpers/me.js'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/seasons', component: { template: '<div />' } },
      { path: '/docs', component: { template: '<div />' } },
      { path: '/my/agents', component: { template: '<div />' } },
      { path: '/my/profile', component: { template: '<div />' } },
      { path: '/admin/users', component: { template: '<div />' } },
      { path: '/admin/logs', component: { template: '<div />' } },
      { path: '/environments/:envId', component: { template: '<div />' } },
      { path: '/login', component: { template: '<div />' } },
    ],
  })
}

async function renderSidebar(path = '/') {
  const router = makeRouter()
  router.push(path)
  await router.isReady()

  // The account block reads /api/me, so render under the provider the way the shell wires it.
  render(MeProvider, {
    slots: { default: () => h(AppSidebar) },
    global: { plugins: [router] },
  })
  return router
}

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
  })

  it('renders the global sections with their destinations', async () => {
    await renderSidebar('/')

    expect(document.querySelector('.brand-icon')).toHaveAttribute('src', '/game-sandbox-icon.png')
    expect(screen.getByRole('link', { name: 'Environments' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Seasons' })).toHaveAttribute('href', '/seasons')
    expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/docs')
    expect(screen.getByRole('link', { name: 'My Agents' })).toHaveAttribute('href', '/my/agents')
  })

  it('updates the active section when navigating from seasons to a game', async () => {
    const router = await renderSidebar('/seasons')

    expect(screen.getByRole('link', { name: 'Seasons' })).toHaveClass('active')
    expect(screen.getByRole('link', { name: 'Environments' })).not.toHaveClass('active')

    await router.push('/environments/flappy_bird')
    expect(screen.getByRole('link', { name: 'Environments' })).toHaveClass('active')
    expect(screen.getByRole('link', { name: 'Seasons' })).not.toHaveClass('active')
  })

  it('shows the Users and Logs destinations only for an admin', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('admin-1', 'admin'))
    await renderSidebar('/')

    const users = await screen.findByRole('link', { name: 'Users' })
    const logs = screen.getByRole('link', { name: 'Logs' })
    expect(users).toHaveAttribute('href', '/admin/users')
    expect(logs).toHaveAttribute('href', '/admin/logs')
  })

  it('hides the Users entry for a normal user', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('u1', 'normal'))
    await renderSidebar('/')

    await screen.findByRole('link', { name: 'Environments' })
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Logs' })).toBeNull()
  })
})
