/**
 * The deployment's site name, hoisted to module scope so the sidebar brand, the mobile bar, and the
 * document title all read one source — the same shared-chrome pattern as `useSidebar`.
 *
 * It defaults to the class-scale brand so the UI renders immediately with no flash, then `loadSiteConfig`
 * (called once from the entrypoint) replaces it with the operator's `SITE_NAME` from `GET /api/config`.
 * A failed fetch keeps the default. Tests read the default without touching the network, since only the
 * entrypoint triggers the load.
 */
import { type Ref, readonly, ref } from 'vue'

import { getSiteConfig } from '../api/client.js'

/** The frontend placeholder brand, matching the backend's `DEFAULT_SITE_NAME` so the two never diverge. */
export const DEFAULT_SITE_NAME = 'Game Sandbox'
export const DEFAULT_SITE_ICON_URL = '/game-sandbox-icon.png'
export const DEFAULT_FAVICON_URL = '/game-sandbox-favicon.png'

const siteName = ref(DEFAULT_SITE_NAME)
const siteIconUrl = ref(DEFAULT_SITE_ICON_URL)
const siteShortName = ref(DEFAULT_SITE_NAME)
// Whether the deployment enabled GitHub OAuth. Defaults to false so the login page hides the GitHub
// button until the public config read confirms it; the login page reads this the same way the chrome
// reads the brand, since it needs the flag before any session exists.
const githubAuth = ref(false)

/**
 * Fetch the deployment branding once and apply it to the shared brand and the document title. Called
 * from `main.ts` at startup; a failed or malformed response leaves the default brand in place.
 */
export async function loadSiteConfig(): Promise<void> {
  try {
    const config = await getSiteConfig()
    if (typeof config.site_name === 'string' && config.site_name !== '') {
      siteName.value = config.site_name
      document.title = config.site_name
    }
    if (typeof config.site_icon_url === 'string' && config.site_icon_url !== '') {
      siteIconUrl.value = config.site_icon_url
      const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (favicon !== null) {
        favicon.href =
          config.site_icon_url === DEFAULT_SITE_ICON_URL
            ? DEFAULT_FAVICON_URL
            : config.site_icon_url
      }
    }
    // The short name mirrors the full name unless the deployment set a distinct one.
    if (typeof config.site_short_name === 'string' && config.site_short_name !== '') {
      siteShortName.value = config.site_short_name
    }
    githubAuth.value = config.github_auth === true
  } catch {
    // The default brand already renders; a branding fetch failure is not worth surfacing to the user.
  }
}

/** The reactive, read-only deployment config for the chrome and login page to render. */
export function useSiteConfig(): {
  siteName: Readonly<Ref<string>>
  siteIconUrl: Readonly<Ref<string>>
  siteShortName: Readonly<Ref<string>>
  githubAuth: Readonly<Ref<boolean>>
} {
  return {
    siteName: readonly(siteName),
    siteIconUrl: readonly(siteIconUrl),
    siteShortName: readonly(siteShortName),
    githubAuth: readonly(githubAuth),
  }
}
