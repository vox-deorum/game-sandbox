/**
 * The stub user identity, resolved per request, until Stage 4 brings GitHub OAuth.
 *
 * This is the one place the backend decides who a request belongs to: the `x-sandbox-user`
 * header when present, otherwise `dev-user`. The one-concurrent-session-per-user rule and
 * every route that attributes anything to a user key on this output. Stage 4 replaces the
 * resolution with the OAuth session without touching callers; nothing else in the backend
 * may invent its own notion of identity.
 */

/** The fallback identity used when no `x-sandbox-user` header is present. */
export const DEV_USER_ID = 'dev-user'

const HEADER = 'x-sandbox-user'

/** A minimal view of the per-request headers, so this stays framework-agnostic and testable. */
export type RequestHeaders = Record<string, string | string[] | undefined>

/** Resolve the acting user id from request headers. */
export function resolveUserId(headers: RequestHeaders): string {
  const raw = headers[HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined) {
    return DEV_USER_ID
  }
  const trimmed = value.trim()
  return trimmed === '' ? DEV_USER_ID : trimmed
}
