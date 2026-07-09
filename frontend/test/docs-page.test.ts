import { fireEvent, screen } from '@testing-library/vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getDocsManifest: vi.fn(),
  getDocsIndex: vi.fn(),
  getDocsPage: vi.fn(),
}))

import { getDocsIndex, getDocsManifest, getDocsPage, getMe } from '../src/api/client.js'
import DocsPage from '../src/pages/DocsPage.vue'

const MANIFEST = {
  pages: [
    { path: 'students/getting-started.md', title: 'Getting Started' },
    {
      path: 'students/environments/index.md',
      title: 'Environments',
      children: [{ path: 'students/environments/hearts.md', title: 'Hearts' }],
    },
    { path: 'students/submitting.md', title: 'Submitting' },
  ],
}

async function renderDocs(path: string) {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/docs', component: DocsPage },
    { path: '/docs/:docPath(.*)', component: DocsPage },
  ])
  router.push(path)
  await router.isReady()
  return { router, ...renderWithMe(router) }
}

describe('DocsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'normal'))
    vi.mocked(getDocsManifest).mockResolvedValue(MANIFEST)
    vi.mocked(getDocsIndex).mockResolvedValue({
      path: 'students/index.md',
      content: '# For Students\n\nWelcome to the guides.\n',
    })
  })

  it('renders the landing index and the navigation from the manifest', async () => {
    await renderDocs('/docs')
    // The landing content comes from getDocsIndex, the nav titles from the manifest.
    expect(await screen.findByText('Welcome to the guides.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Getting Started' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Environments' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Hearts' })).toBeTruthy()
    expect(getDocsIndex).toHaveBeenCalledOnce()
  })

  it('resolves a deep-linked route to its source page and fetches it', async () => {
    vi.mocked(getDocsPage).mockResolvedValue({
      path: 'students/getting-started.md',
      content: '# Getting Started\n\nInstall Python first.\n',
    })
    await renderDocs('/docs/students/getting-started')
    expect(await screen.findByText('Install Python first.')).toBeTruthy()
    expect(getDocsPage).toHaveBeenCalledWith('students/getting-started.md')
    expect(getDocsIndex).not.toHaveBeenCalled()
  })

  it('shows a not-found state for a route absent from the manifest', async () => {
    await renderDocs('/docs/students/nope')
    expect(await screen.findByText(/was not found/)).toBeTruthy()
    expect(getDocsPage).not.toHaveBeenCalled()
  })

  it('still resolves a deep link when the manifest fetch fails, deriving the source from the route', async () => {
    vi.mocked(getDocsManifest).mockRejectedValue(new Error('offline'))
    vi.mocked(getDocsPage).mockResolvedValue({
      path: 'students/getting-started.md',
      content: '# Getting Started\n\nInstall Python first.\n',
    })
    await renderDocs('/docs/students/getting-started')
    // With no manifest to map the route, the page derives students/getting-started.md and fetches it.
    expect(await screen.findByText('Install Python first.')).toBeTruthy()
    expect(getDocsPage).toHaveBeenCalledWith('students/getting-started.md')
  })

  it('shows not-found when a manifest-outage deep link points at a missing guide', async () => {
    vi.mocked(getDocsManifest).mockRejectedValue(new Error('offline'))
    // The backend answers 404 for the derived guess; that maps to not-found, not the error state.
    vi.mocked(getDocsPage).mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
    await renderDocs('/docs/students/ghost')
    expect(await screen.findByText(/was not found/)).toBeTruthy()
  })

  it('shows an error state when the page fetch fails', async () => {
    vi.mocked(getDocsIndex).mockRejectedValue(new Error('offline'))
    await renderDocs('/docs')
    expect(await screen.findByText(/Could not load the documentation/)).toBeTruthy()
  })

  it('navigates in-app when an internal doc link is clicked', async () => {
    vi.mocked(getDocsPage).mockImplementation(async (path: string) => ({
      path,
      content:
        path === 'students/getting-started.md'
          ? '# Getting Started\n\nThen [submit your agent](submitting.md).\n'
          : '# Submitting\n\nPush to GitHub.\n',
    }))
    const { router } = await renderDocs('/docs/students/getting-started')
    const link = await screen.findByRole('link', { name: 'submit your agent' })
    // The renderer rewrote the relative .md link to the in-app route and tagged it internal.
    expect(link.getAttribute('href')).toBe('/docs/students/submitting')
    await fireEvent.click(link)
    expect(await screen.findByText('Push to GitHub.')).toBeTruthy()
    expect(router.currentRoute.value.path).toBe('/docs/students/submitting')
    expect(getDocsPage).toHaveBeenCalledWith('students/submitting.md')
  })
})
