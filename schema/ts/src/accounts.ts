/**
 * Account status shared by the backend identity seam and the frontend roster UI.
 *
 * Better Auth stores a raw `role` string; the request-time status both sides show is derived from it.
 * The derivation lives here, dependency-free, so the backend guard and the browser roster read one
 * definition instead of each re-spelling the precedence (and risking drift). No Node built-ins or Ajv,
 * so the frontend imports it directly through the package's subpath export.
 *
 * The masked-name label helpers also live here, dependency-free in the same way: the backend masks
 * public name fields and the frontend renders masked viewers' labels from the same function, so a
 * masked "Agent \<hash\>" on one surface always agrees with the hash the other computes.
 */

/** The four request-time statuses. `banned` is orthogonal: a banned user has no live session. */
export type UserStatus = 'pending' | 'normal' | 'guest' | 'admin'

/**
 * Derive the request-time status from Better Auth's raw `role`, which may hold a comma-separated list
 * (the admin plugin comma-splits the same string for its own permission checks). Precedence: any
 * `admin` token wins, else any `user` token is `normal`, else any `guest` token is `guest`, else
 * `pending`. An empty token, an unknown value, and a missing role all fall through to `pending`,
 * failing the active, player, and admin guards closed.
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
  if (tokens.includes('guest')) {
    return 'guest'
  }
  return 'pending'
}

/**
 * The stable 6-character hex label every masked surface shows for a user: a FNV-1a hash of the user id,
 * so the same user reads as the same label wherever a masked viewer follows them, without revealing who
 * they are. The backend and frontend call the same function, so a server-masked label and a client-side
 * remask agree.
 */
export function maskedUserHash(userId: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < userId.length; index += 1) {
    hash ^= userId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

/**
 * The one masked label every surface shows: `Agent <hash>`, stable across every surface. Masked
 * humans read the same way, so a masked viewer cannot tell a human seat from an agent seat.
 */
export function maskedAgentLabel(userId: string): string {
  return `Agent ${maskedUserHash(userId)}`
}
