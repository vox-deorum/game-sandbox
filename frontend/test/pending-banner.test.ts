import { render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter } from './helpers/render.js'

// AppShell's subtree pulls in AccountMenu (authClient) and ExperimentTabs (getEnvironments); mock the
// modules so getMe is controllable and no real Better Auth client or network is touched.
vi.mock('../src/auth.js', () => ({
  authClient: { signIn: { email: vi.fn(), social: vi.fn() }, signOut: vi.fn() },
}))
vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getEnvironments: vi.fn(),
  getSiteConfig: vi.fn(),
}))

import { getMe } from '../src/api/client.js'
import AppShell from '../src/components/AppShell.vue'
import { MeProvider } from '../src/me.js'

const BANNER = 'Your account is awaiting approval.'

async function renderShell() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/seasons', component: { template: '<div />' } },
    { path: '/docs', component: { template: '<div />' } },
    { path: '/my/agents', component: { template: '<div />' } },
    { path: '/my/profile', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ])
  router.push('/')
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(AppShell) },
    global: { plugins: [router] },
  })
}

describe('AppShell pending banner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the awaiting-approval banner for a pending user', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('p', 'pending'))
    await renderShell()
    expect(await screen.findByText(BANNER)).toBeInTheDocument()
  })

  it('hides the banner for a normal user', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('n', 'normal'))
    await renderShell()
    // Wait for the resolved identity to reach the account block, then assert the banner never appears.
    expect(await screen.findByText('n')).toBeInTheDocument()
    expect(screen.queryByText(BANNER)).toBeNull()
  })

  it('hides the banner for an anonymous visitor', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    await renderShell()
    expect(await screen.findByRole('link', { name: /Sign in/i })).toBeInTheDocument()
    expect(screen.queryByText(BANNER)).toBeNull()
  })
})
