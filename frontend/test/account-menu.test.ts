import { fireEvent, render, screen } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter } from './helpers/render.js'

// AccountMenu imports authClient (reads window.location.origin at import) and ends the session through
// authClient.signOut, so stub the module out.
vi.mock('../src/auth.js', () => ({
  authClient: { signIn: { email: vi.fn(), social: vi.fn() }, signOut: vi.fn() },
}))

// The account block reads /api/me through the MeProvider.
vi.mock('../src/api/client.js', () => ({ getMe: vi.fn() }))

import { getMe } from '../src/api/client.js'
import { authClient } from '../src/auth.js'
import AccountMenu from '../src/components/AccountMenu.vue'
import { MeProvider } from '../src/me.js'

const signOut = vi.mocked(authClient.signOut)

let assignSpy: ReturnType<typeof vi.fn>
let originalLocation: Location

async function renderMenu() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/my/profile', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ])
  router.push('/')
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(AccountMenu) },
    global: { plugins: [router] },
  })
}

describe('AccountMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    signOut.mockResolvedValue(undefined as never)

    originalLocation = window.location
    assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        pathname: '/',
        origin: 'http://localhost',
        href: 'http://localhost/',
        assign: assignSpy,
      },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    })
  })

  it('shows the user and logs out through authClient, then navigates to /login', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('alice', 'normal'))
    await renderMenu()

    expect(await screen.findByText('alice')).toBeInTheDocument()
    const logout = screen.getByRole('button', { name: 'Log out' })
    expect(logout).toBeEnabled()

    await fireEvent.click(logout)
    await vi.waitFor(() => expect(signOut).toHaveBeenCalled())
    await vi.waitFor(() => expect(assignSpy).toHaveBeenCalledWith('/login'))
  })

  it('shows a Sign in link and no Log out when signed out', async () => {
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    await renderMenu()

    const signIn = await screen.findByRole('link', { name: /Sign in/i })
    expect(signIn).toHaveAttribute('href', '/login')
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull()
  })

  it('shows a connected GitHub handle below the display name', async () => {
    vi.mocked(getMe).mockResolvedValue(
      signedInMe('alice', 'normal', { name: 'Alice', github_username: 'alice-dev' }),
    )
    await renderMenu()

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByText('@alice-dev')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: "Alice's avatar" })).toHaveTextContent('A')
  })
})
