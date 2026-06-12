/**
 * The mock auto-logon. One development user, signed in automatically, with no login page, no logout,
 * and no session storage.
 *
 * The username resolves once: the `VITE_SANDBOX_USER` dev override when set, otherwise `dev-user`,
 * matching the backend identity stub's fallback. Every API request carries the identity as the
 * `x-sandbox-user` header. The browser WebSocket API cannot set headers, so the socket client appends
 * the identity as a `user` query parameter instead; the backend's `resolveUserId` reads either source.
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

function resolveUser(): string {
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
