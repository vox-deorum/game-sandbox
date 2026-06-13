/**
 * The mock auto-logon. One development user, signed in automatically, with no login page, no logout,
 * and no session storage.
 *
 * The username resolves once: a per-browser `localStorage` override when set, otherwise the
 * `VITE_SANDBOX_USER` dev override, otherwise `dev-user`, matching the backend identity stub's
 * fallback. Every API request carries the identity as the `x-sandbox-user` header. The browser
 * WebSocket API cannot set headers, so the socket client appends the identity as a `user` query
 * parameter instead; the backend's `resolveUserId` reads either source.
 *
 * The `localStorage` override is what lets two contexts of one build act as different users — the
 * spectator scenario, where a second browser opens a session it does not own and must get no controls.
 * `VITE_SANDBOX_USER` is build-time, so it cannot vary per context; the runtime override can.
 *
 * This is the one frontend place identity is decided. When GitHub OAuth lands it replaces this module
 * with the real session (a cookie the browser sends on both fetch and upgrade automatically) and no
 * caller changes.
 */

/** The header every API request carries so the backend can attribute it to the acting user. */
export const IDENTITY_HEADER = 'x-sandbox-user'
/** The query parameter the socket client uses, since a header cannot ride a WebSocket upgrade. */
export const IDENTITY_QUERY_PARAM = 'user'
/** The fallback id, matching the backend stub's `dev-user`, so a fresh checkout plays out of the box. */
export const DEFAULT_USER = 'dev-user'
/** The `localStorage` key a context sets to act as a specific user at runtime (e.g. a spectator). */
export const IDENTITY_STORAGE_KEY = 'sandbox-user'

/** The per-browser runtime override, if any. Guarded because `localStorage` can be absent or throw. */
function storedUser(): string | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(IDENTITY_STORAGE_KEY)
    const trimmed = raw?.trim()
    return trimmed === undefined || trimmed === '' ? undefined : trimmed
  } catch {
    return undefined
  }
}

function resolveUser(): string {
  const runtime = storedUser()
  if (runtime !== undefined) {
    return runtime
  }
  const override = import.meta.env.VITE_SANDBOX_USER
  return typeof override === 'string' && override.trim() !== '' ? override.trim() : DEFAULT_USER
}

/** The signed-in mock user's id, resolved once at module load. */
export const currentUserId: string = resolveUser()

/** The identity header to merge into every API request. */
export function identityHeaders(): Record<string, string> {
  return { [IDENTITY_HEADER]: currentUserId }
}

/** Append the identity to a WebSocket URL, the only channel that cannot carry the header. */
export function withIdentityParam(url: URL): URL {
  url.searchParams.set(IDENTITY_QUERY_PARAM, currentUserId)
  return url
}
