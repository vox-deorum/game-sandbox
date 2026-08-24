import { afterEach, describe, expect, it, vi } from 'vitest'

import { jsonResponse, stubFetch } from './helpers/fetchStub.js'

// The composable is a module singleton, so each case re-imports a fresh copy to reset its refs.
async function freshSiteConfig() {
  vi.resetModules()
  return import('../src/composables/useSiteConfig.js')
}

describe('useSiteConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.querySelector('link[rel="icon"]')?.remove()
  })

  it('starts at the default name and icon', async () => {
    const { useSiteConfig, DEFAULT_SITE_ICON_URL, DEFAULT_SITE_NAME } = await freshSiteConfig()
    const { siteIconUrl, siteName, siteShortName } = useSiteConfig()
    expect(siteName.value).toBe(DEFAULT_SITE_NAME)
    expect(siteIconUrl.value).toBe(DEFAULT_SITE_ICON_URL)
    expect(siteShortName.value).toBe(DEFAULT_SITE_NAME)
  })

  it('applies the fetched brand to the chrome, document title, and favicon', async () => {
    const favicon = document.createElement('link')
    favicon.rel = 'icon'
    favicon.href = '/game-sandbox-icon.png'
    document.head.append(favicon)
    stubFetch(async () =>
      jsonResponse({
        site_name: 'Acme Arena',
        site_icon_url: 'https://cdn.example.edu/acme.svg',
        site_short_name: 'Acme',
      }),
    )
    const { useSiteConfig, loadSiteConfig } = await freshSiteConfig()
    await loadSiteConfig()
    const { siteIconUrl, siteName, siteShortName } = useSiteConfig()
    expect(siteName.value).toBe('Acme Arena')
    expect(siteIconUrl.value).toBe('https://cdn.example.edu/acme.svg')
    expect(siteShortName.value).toBe('Acme')
    expect(document.title).toBe('Acme Arena')
    expect(favicon.href).toBe('https://cdn.example.edu/acme.svg')
  })

  it('keeps the default brand when the config fetch fails', async () => {
    stubFetch(async () => new Response(null, { status: 500 }))
    const { useSiteConfig, loadSiteConfig, DEFAULT_SITE_NAME } = await freshSiteConfig()
    await loadSiteConfig()
    const { siteIconUrl, siteName, siteShortName } = useSiteConfig()
    expect(siteName.value).toBe(DEFAULT_SITE_NAME)
    expect(siteIconUrl.value).toBe('/game-sandbox-icon.png')
    expect(siteShortName.value).toBe(DEFAULT_SITE_NAME)
  })

  it('defaults githubAuth to false before any load', async () => {
    const { useSiteConfig } = await freshSiteConfig()
    expect(useSiteConfig().githubAuth.value).toBe(false)
  })

  it('parses github_auth: true into githubAuth', async () => {
    stubFetch(async () => jsonResponse({ site_name: 'X', site_short_name: 'X', github_auth: true }))
    const { useSiteConfig, loadSiteConfig } = await freshSiteConfig()
    await loadSiteConfig()
    expect(useSiteConfig().githubAuth.value).toBe(true)
  })

  it('leaves githubAuth false when github_auth is absent or false', async () => {
    stubFetch(async () => jsonResponse({ site_name: 'X', site_short_name: 'X' }))
    const { useSiteConfig, loadSiteConfig } = await freshSiteConfig()
    await loadSiteConfig()
    expect(useSiteConfig().githubAuth.value).toBe(false)
  })
})
