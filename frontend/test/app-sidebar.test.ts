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
}

describe('AppSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
  })

  it('renders the global sections with their destinations', async () => {
    await renderSidebar('/')

    expect(screen.getByRole('link', { name: 'Environments' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Seasons' })).toHaveAttribute('href', '/seasons')
    expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/docs')
    expect(screen.getByRole('link', { name: 'My Agents' })).toHaveAttribute('href', '/my/agents')
  })

  it('marks Environments active on a game route without marking it active elsewhere', async () => {
    await renderSidebar('/seasons')

    // On /seasons the Seasons item is active and Environments is not (the root link must not match every path).
    expect(screen.getByRole('link', { name: 'Seasons' })).toHaveClass('active')
    expect(screen.getByRole('link', { name: 'Environments' })).not.toHaveClass('active')
  })

  it('shows the Users entry, last, only for an admin', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('admin-1', 'admin'))
    await renderSidebar('/')

    const users = await screen.findByRole('link', { name: 'Users' })
    expect(users).toHaveAttribute('href', '/admin/users')

    const links = screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-label'))
    expect(links[links.length - 1]).toBe(users)
  })

  it('hides the Users entry for a normal user', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('u1', 'normal'))
    await renderSidebar('/')

    await screen.findByRole('link', { name: 'Environments' })
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull()
  })
})
