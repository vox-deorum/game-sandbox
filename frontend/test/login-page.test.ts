import { fireEvent, render, screen } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'

import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter } from './helpers/render.js'

// The Better Auth client reads window.location.origin at import, so stub it out entirely; the page
// drives it through signIn.email / signIn.social.
vi.mock('../src/auth.js', () => ({
  authClient: { signIn: { email: vi.fn(), social: vi.fn() }, signOut: vi.fn() },
}))

// The page renders under the MeProvider, which fetches /api/me through getMe.
vi.mock('../src/api/client.js', () => ({ getMe: vi.fn() }))

// A hoisted flag lets each test choose whether the deployment offers GitHub sign-in before the page
// reads useSiteConfig().githubAuth during setup. The factory builds a fresh ref from it per call.
const site = vi.hoisted(() => ({ github: false }))
vi.mock('../src/composables/useSiteConfig.js', async () => {
  const { ref } = await import('vue')
  return {
    useSiteConfig: () => ({
      siteName: ref('X'),
      siteShortName: ref('X'),
      githubAuth: ref(site.github),
    }),
  }
})

import { getMe } from '../src/api/client.js'
import { authClient } from '../src/auth.js'
import { MeProvider } from '../src/me.js'
import LoginPage from '../src/pages/LoginPage.vue'

const signInEmail = vi.mocked(authClient.signIn.email)
const signInSocial = vi.mocked(authClient.signIn.social)

let assignSpy: ReturnType<typeof vi.fn>
let originalLocation: Location

async function renderLogin() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ])
  router.push('/login')
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(LoginPage) },
    global: { plugins: [router] },
  })
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    site.github = false
    vi.mocked(getMe).mockResolvedValue(anonymousMe)
    signInEmail.mockResolvedValue({ error: null } as never)
    signInSocial.mockResolvedValue({} as never)

    originalLocation = window.location
    assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        pathname: '/login',
        origin: 'http://localhost',
        href: 'http://localhost/login',
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

  /** Wait for the /api/me check to settle so the submit button is enabled, then return it. */
  async function readySubmit() {
    const button = await screen.findByRole('button', { name: 'Sign in' })
    await vi.waitFor(() => expect(button).toBeEnabled())
    return button
  }

  it('signs in with email and password, then navigates to /', async () => {
    await renderLogin()
    const submit = await readySubmit()
    await fireEvent.update(screen.getByLabelText('Email'), 'a@b.com')
    await fireEvent.update(screen.getByLabelText('Password'), 'secret')
    await fireEvent.click(submit)

    await vi.waitFor(() =>
      expect(signInEmail).toHaveBeenCalledWith({ email: 'a@b.com', password: 'secret' }),
    )
    await vi.waitFor(() => expect(assignSpy).toHaveBeenCalledWith('/'))
  })

  it('shows the wrong-credential message and does not navigate', async () => {
    signInEmail.mockResolvedValue({ error: { message: 'Invalid email or password' } } as never)
    await renderLogin()
    const submit = await readySubmit()
    await fireEvent.update(screen.getByLabelText('Email'), 'a@b.com')
    await fireEvent.update(screen.getByLabelText('Password'), 'nope')
    await fireEvent.click(submit)

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
    expect(assignSpy).not.toHaveBeenCalledWith('/')
  })

  it('surfaces the banned-account message', async () => {
    signInEmail.mockResolvedValue({
      error: { message: 'You have been banned from this application', code: 'BANNED_USER' },
    } as never)
    await renderLogin()
    const submit = await readySubmit()
    await fireEvent.update(screen.getByLabelText('Email'), 'a@b.com')
    await fireEvent.update(screen.getByLabelText('Password'), 'secret')
    await fireEvent.click(submit)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You have been banned from this application',
    )
  })

  it('shows the GitHub button only when github_auth is on, and starts the OAuth flow', async () => {
    site.github = true
    await renderLogin()
    const github = await screen.findByRole('button', { name: 'Sign in with GitHub' })
    await vi.waitFor(() => expect(github).toBeEnabled())
    await fireEvent.click(github)
    expect(signInSocial).toHaveBeenCalledWith({ provider: 'github', callbackURL: '/' })
  })

  it('hides the GitHub button when github_auth is off', async () => {
    site.github = false
    await renderLogin()
    await readySubmit()
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull()
  })

  it('redirects an already-signed-in visitor away from /login on mount', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('u', 'normal'))
    await renderLogin()
    await vi.waitFor(() => expect(assignSpy).toHaveBeenCalledWith('/'))
  })
})
