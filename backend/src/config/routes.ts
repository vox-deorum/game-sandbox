import type { FastifyInstance } from 'fastify'

// Isolated buildApp tests may omit deployment wiring. Runtime startup always passes the validated
// values loaded through Config; this fallback mirrors `.env.default` for app-only callers.
const DEFAULT_SITE_NAME = 'Game Sandbox'
const DEFAULT_SITE_ICON_URL = '/game-sandbox-icon.png'

/** The public deployment configuration the SPA reads at startup. */
export interface ConfigRouteDeps {
  siteName?: string
  siteIconUrl?: string
  siteShortName?: string
  githubAuth?: boolean
}

/** Register the public deployment-configuration route. */
export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): void {
  // The public deployment branding the SPA reads once at startup, so the sidebar brand and the
  // document title reflect the operator's `SITE_NAME` rather than a hardcoded string. Unauthenticated
  // and read-only; extend this payload as more client-facing site config appears.
  app.get('/api/config', () => {
    const siteName = deps.siteName ?? DEFAULT_SITE_NAME
    return {
      site_name: siteName,
      site_icon_url: deps.siteIconUrl ?? DEFAULT_SITE_ICON_URL,
      site_short_name: deps.siteShortName ?? siteName,
      github_auth: deps.githubAuth ?? false,
    }
  })
}
