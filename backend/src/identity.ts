/**
 * The stub user identity, resolved per request, until GitHub OAuth lands as deferred Stage 4 work.
 *
 * This is the one place the backend decides who a request belongs to: the `x-sandbox-user` header
 * when present, otherwise the `user` query parameter (the browser WebSocket API cannot set a header
 * on the upgrade, so the socket client carries the identity there), otherwise `dev-user`. The
 * one-concurrent-session-per-user rule and every route that attributes anything to a user key on
 * this output. OAuth replaces the resolution with the session cookie (sent on both fetch and upgrade
 * automatically) without touching callers; nothing else in the backend may invent its own notion of
 * identity.
 */

/** The fallback identity used when neither the header nor the query parameter names a user. */
export const DEV_USER_ID = 'dev-user'

const HEADER = 'x-sandbox-user'
const QUERY_PARAM = 'user'

/** A minimal view of the per-request headers, so this stays framework-agnostic and testable. */
export type RequestHeaders = Record<string, string | string[] | undefined>
/** A minimal view of the parsed query string of a WebSocket upgrade (or any request). */
export type RequestQuery = Record<string, string | string[] | undefined>

function firstNonBlank(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve the acting user id: the header first, then the WS-friendly `user` query parameter, then
 * the dev-user fallback. The query source exists only because a browser cannot attach a header to a
 * WebSocket upgrade; it is the same identity, decided in the same single function.
 */
export function resolveUserId(headers: RequestHeaders, query?: RequestQuery): string {
  const fromHeader = firstNonBlank(headers[HEADER])
  if (fromHeader !== undefined) {
    return fromHeader
  }
  const fromQuery = query === undefined ? undefined : firstNonBlank(query[QUERY_PARAM])
  return fromQuery ?? DEV_USER_ID
}

/** Whether a resolved user id may start live sessions, per the operator-configured allowlist. */
export function isAllowlisted(userId: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(userId)
}
