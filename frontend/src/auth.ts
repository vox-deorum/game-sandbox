/**
 * The one Better Auth Vue client the app uses. Sign-in, sign-out, and the admin roster calls go
 * through this client; every other request keeps using the typed wrappers in `api/client.ts`, which
 * ride the same session cookie this client establishes.
 *
 * The `adminClient` plugin is attached here so the same construction serves the roster page without a
 * second client. The base URL points at the backend's mounted auth handler on the current origin.
 */
import { adminClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/vue'

export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/api/auth`,
  plugins: [adminClient()],
})
