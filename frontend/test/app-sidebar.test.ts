import { render, screen } from '@testing-library/vue'
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'

import AppSidebar from '../src/components/AppSidebar.vue'
import { MeProvider } from '../src/me.js'

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/seasons', component: { template: '<div />' } },
      { path: '/docs', component: { template: '<div />' } },
      { path: '/my/agents', component: { template: '<div />' } },
      { path: '/my/profile', component: { template: '<div />' } },
      { path: '/environments/:envId', component: { template: '<div />' } },
    ],
  })
}

describe('AppSidebar', () => {
  it('renders the global sections with their destinations', async () => {
    const router = makeRouter()
    router.push('/')
    await router.isReady()

    // The account block reads /api/me, so render under the provider the way the shell wires it.
    render(MeProvider, {
      slots: { default: () => h(AppSidebar) },
      global: { plugins: [router] },
    })

    expect(screen.getByRole('link', { name: 'Environments' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Seasons' })).toHaveAttribute('href', '/seasons')
    expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/docs')
    expect(screen.getByRole('link', { name: 'My Agents' })).toHaveAttribute('href', '/my/agents')
  })

  it('marks Environments active on a game route without marking it active elsewhere', async () => {
    const router = makeRouter()
    router.push('/seasons')
    await router.isReady()

    render(MeProvider, {
      slots: { default: () => h(AppSidebar) },
      global: { plugins: [router] },
    })

    // On /seasons the Seasons item is active and Environments is not (the root link must not match every path).
    expect(screen.getByRole('link', { name: 'Seasons' })).toHaveClass('active')
    expect(screen.getByRole('link', { name: 'Environments' })).not.toHaveClass('active')
  })
})
