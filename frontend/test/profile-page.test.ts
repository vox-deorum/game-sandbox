import { render, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { RouterView } from 'vue-router'

import { anonymousMe, signedInMe } from './helpers/me.js'
import { memoryRouter } from './helpers/render.js'

// The page reads /api/me through the MeProvider.
vi.mock('../src/api/client.js', () => ({ getMe: vi.fn() }))
vi.mock('../src/auth.js', () => ({
  authClient: { listAccounts: vi.fn(), linkSocial: vi.fn(), unlinkAccount: vi.fn() },
}))

const githubAuth = vi.hoisted(() => ({ __v_isRef: true, value: false }))
vi.mock('../src/composables/useSiteConfig.js', () => ({
  useSiteConfig: () => ({ githubAuth }),
}))

import { getMe } from '../src/api/client.js'
import { authClient } from '../src/auth.js'
import AccountMenu from '../src/components/AccountMenu.vue'
import { MeProvider } from '../src/me.js'
import ProfilePage from '../src/pages/ProfilePage.vue'

async function renderProfile(path = '/') {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/my/profile', component: { template: '<div />' } },
    { path: '/my/agents', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ])
  await router.push(path)
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(ProfilePage) },
    global: { plugins: [router] },
  })
}

async function renderProfileWithAccountMenu() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/my/profile', component: { template: '<div />' } },
    { path: '/my/agents', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ])
  await router.push('/my/profile')
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h('div', [h(AccountMenu), h(ProfilePage)]) },
    global: { plugins: [router] },
  })
}

async function renderProfileCallbackError() {
  const router = memoryRouter([
    { path: '/my/profile', component: ProfilePage },
    { path: '/my/agents', component: { template: '<div />' } },
    { path: '/login', component: { template: '<div />' } },
  ])
  await router.push({ path: '/my/profile', query: { error: 'access_denied' } })
  await router.isReady()
  return render(MeProvider, {
    slots: { default: () => h(RouterView) },
    global: { plugins: [router] },
  })
}

describe('ProfilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    githubAuth.value = false
    vi.mocked(authClient.listAccounts).mockResolvedValue({ data: [], error: null } as never)
    vi.mocked(authClient.linkSocial).mockResolvedValue({ data: null, error: null } as never)
    vi.mocked(authClient.unlinkAccount).mockResolvedValue({ data: null, error: null } as never)
  })

  it('renders a normal user by name and email, with a Member badge and no raw id label', async () => {
    vi.mocked(getMe).mockResolvedValue(
      signedInMe('bob', 'normal', { name: 'Bob', email: 'bob@x.io' }),
    )
    await renderProfile()

    expect(await screen.findByText('Bob')).toBeInTheDocument()
    expect(screen.getByText('bob@x.io')).toBeInTheDocument()
    expect(screen.getByText('Member')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Connected accounts' })).toBeNull()
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

  it('shows the connected GitHub account and disconnects it when another sign-in method remains', async () => {
    githubAuth.value = true
    let finishRefresh: ((value: ReturnType<typeof signedInMe>) => void) | undefined
    const refreshedMe = new Promise<ReturnType<typeof signedInMe>>((resolve) => {
      finishRefresh = resolve
    })
    vi.mocked(getMe)
      .mockResolvedValueOnce(
        signedInMe('bob', 'normal', { name: 'Bob', github_username: 'bob-dev' }),
      )
      .mockReturnValueOnce(refreshedMe)
    vi.mocked(authClient.listAccounts)
      .mockResolvedValueOnce({
        data: [
          { providerId: 'credential', accountId: 'password' },
          { providerId: 'github', accountId: '1234' },
        ],
        error: null,
      } as never)
      .mockResolvedValueOnce({
        data: [{ providerId: 'credential', accountId: 'password' }],
        error: null,
      } as never)
    await renderProfileWithAccountMenu()

    const github = await screen.findByRole('link', { name: 'GitHub @bob-dev' })
    expect(github).toHaveAttribute('href', 'https://github.com/bob-dev')
    const disconnect = screen.getByRole('button', { name: 'Disconnect GitHub' })
    expect(disconnect).toBeEnabled()
    await disconnect.click()
    await vi.waitFor(() =>
      expect(authClient.unlinkAccount).toHaveBeenCalledWith({
        providerId: 'github',
        accountId: '1234',
      }),
    )
    await vi.waitFor(() => expect(getMe).toHaveBeenCalledTimes(2))
    expect(screen.getAllByText('Bob')).toHaveLength(2)
    expect(screen.getByText('bob@test.local')).toBeInTheDocument()
    expect(screen.getByText('@bob-dev')).toBeInTheDocument()
    expect(screen.queryByText('signing in…')).toBeNull()
    expect(screen.queryByText('Loading…')).toBeNull()

    finishRefresh?.(signedInMe('bob', 'normal', { name: 'Bob' }))
    await vi.waitFor(() =>
      expect(screen.queryByRole('link', { name: 'GitHub @bob-dev' })).toBeNull(),
    )
    expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument()
    await vi.waitFor(() => expect(screen.queryByText('@bob-dev')).toBeNull())
    expect(getMe).toHaveBeenCalledTimes(2)
  })

  it('offers connection only when GitHub OAuth is configured and sends users back to My Profile', async () => {
    githubAuth.value = true
    vi.mocked(getMe).mockResolvedValue(signedInMe('bob'))
    await renderProfile()

    const connect = await screen.findByRole('button', { name: 'Connect GitHub' })
    await connect.click()
    expect(authClient.linkSocial).toHaveBeenCalledWith({
      provider: 'github',
      callbackURL: '/my/profile',
      errorCallbackURL: '/my/profile',
    })
  })

  it('disables disconnect when GitHub is the only sign-in method', async () => {
    githubAuth.value = true
    vi.mocked(getMe).mockResolvedValue(signedInMe('bob', 'normal', { github_username: 'bob-dev' }))
    vi.mocked(authClient.listAccounts).mockResolvedValue({
      data: [{ providerId: 'github', accountId: '1234' }],
      error: null,
    } as never)
    await renderProfile()

    expect(await screen.findByRole('button', { name: 'Disconnect GitHub' })).toBeDisabled()
    expect(screen.getByText(/GitHub is your only sign-in method/)).toBeInTheDocument()
  })

  it('keeps the connection action visible beside a GitHub callback error', async () => {
    githubAuth.value = true
    vi.mocked(getMe).mockResolvedValue(signedInMe('bob'))
    await renderProfileCallbackError()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not connect GitHub: access denied.',
    )
    expect(await screen.findByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument()
  })

  it('clears a transient connected-account error after a successful reload', async () => {
    githubAuth.value = true
    vi.mocked(getMe).mockResolvedValue(signedInMe('bob'))
    vi.mocked(authClient.listAccounts)
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'Temporary account lookup failure.' },
      } as never)
      .mockResolvedValueOnce({ data: [], error: null } as never)
    await renderProfile()

    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary account lookup failure.')
    await screen.getByRole('button', { name: 'Connect GitHub' }).click()

    await vi.waitFor(() => expect(authClient.listAccounts).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
