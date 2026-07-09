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
  })

  it('starts at the default brand for both the full and short names', async () => {
    const { useSiteConfig, DEFAULT_SITE_NAME } = await freshSiteConfig()
    const { siteName, siteShortName } = useSiteConfig()
    expect(siteName.value).toBe(DEFAULT_SITE_NAME)
    expect(siteShortName.value).toBe(DEFAULT_SITE_NAME)
  })

  it('applies the fetched names and sets the document title', async () => {
    stubFetch(async () => jsonResponse({ site_name: 'Acme Arena', site_short_name: 'Acme' }))
    const { useSiteConfig, loadSiteConfig } = await freshSiteConfig()
    await loadSiteConfig()
    const { siteName, siteShortName } = useSiteConfig()
    expect(siteName.value).toBe('Acme Arena')
    expect(siteShortName.value).toBe('Acme')
    expect(document.title).toBe('Acme Arena')
  })

  it('keeps the default brand when the config fetch fails', async () => {
    stubFetch(async () => new Response(null, { status: 500 }))
    const { useSiteConfig, loadSiteConfig, DEFAULT_SITE_NAME } = await freshSiteConfig()
    await loadSiteConfig()
    const { siteName, siteShortName } = useSiteConfig()
    expect(siteName.value).toBe(DEFAULT_SITE_NAME)
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
