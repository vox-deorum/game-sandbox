/**
 * Account status shared by the backend identity seam and the frontend roster UI.
 *
 * Better Auth stores a raw `role` string; the request-time status both sides show is derived from it.
 * The derivation lives here, dependency-free, so the backend guard and the browser roster read one
 * definition instead of each re-spelling the precedence (and risking drift). No Node built-ins or Ajv,
 * so the frontend imports it directly through the package's subpath export.
 */

/** The three request-time statuses. `banned` is orthogonal: a banned user has no live session. */
export type UserStatus = 'pending' | 'normal' | 'admin'

/**
 * Derive the request-time status from Better Auth's raw `role`, which may hold a comma-separated list
 * (the admin plugin comma-splits the same string for its own permission checks). Precedence: any
 * `admin` token wins, else any `user` token is `normal`, else `pending`. An empty token, an unknown
 * value, and a missing role all fall through to `pending`, failing the active and admin guards closed.
 */
export function deriveStatus(role: string | null | undefined): UserStatus {
  if (role === null || role === undefined) {
    return 'pending'
  }
  const tokens = role.split(',').map((token) => token.trim())
  if (tokens.includes('admin')) {
    return 'admin'
  }
  if (tokens.includes('user')) {
    return 'normal'
  }
  return 'pending'
}
