import { render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter } from './helpers/render.js'

// The page reads /api/me through the MeProvider.
vi.mock('../src/api/client.js', () => ({ getMe: vi.fn() }))

import { getMe } from '../src/api/client.js'
import { MeProvider } from '../src/me.js'
import ProfilePage from '../src/pages/ProfilePage.vue'

async function renderProfile() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/my/agents', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ])
  router.push('/')
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(ProfilePage) },
    global: { plugins: [router] },
  })
}

describe('ProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders a normal user by name and email, with a Member badge and no raw id label', async () => {
    vi.mocked(getMe).mockResolvedValue(
      signedInMe('bob', 'normal', { name: 'Bob', email: 'bob@x.io' }),
    )
    await renderProfile()

    expect(await screen.findByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('bob@x.io')).toBeInTheDocument()
    expect(screen.getByText('Member')).toBeInTheDocument()
    // The opaque id is only a diagnostic tooltip, never the presented account label.
    expect(screen.queryByText('bob')).toBeNull()
  })

  it('shows the awaiting-approval badge and note for a pending user', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('p', 'pending'))
    await renderProfile()

    expect(await screen.findByText('Awaiting approval')).toBeInTheDocument()
    expect(screen.getByText(/Your account is awaiting approval/)).toBeInTheDocument()
  })

  it('shows a sign-in prompt and no profile fields when anonymous', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    await renderProfile()

    expect(await screen.findByText('You are not signed in.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
    expect(screen.queryByText('Name')).toBeNull()
    expect(screen.queryByText('Email')).toBeNull()
    expect(screen.queryByText('Access')).toBeNull()
  })
})
