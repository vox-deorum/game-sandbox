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

const siteName = ref(DEFAULT_SITE_NAME)
const siteShortName = ref(DEFAULT_SITE_NAME)

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
    // The short name mirrors the full name unless the deployment set a distinct one.
    if (typeof config.site_short_name === 'string' && config.site_short_name !== '') {
      siteShortName.value = config.site_short_name
    }
  } catch {
    // The default brand already renders; a branding fetch failure is not worth surfacing to the user.
  }
}

/** The reactive, read-only deployment brands for the chrome to render (full and compact forms). */
export function useSiteConfig(): {
  siteName: Readonly<Ref<string>>
  siteShortName: Readonly<Ref<string>>
} {
  return { siteName: readonly(siteName), siteShortName: readonly(siteShortName) }
}
