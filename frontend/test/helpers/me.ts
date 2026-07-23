/**
 * Shared /api/me fixtures for the new Better Auth session shape (Stage 12.3). Component suites mock
 * `getMe` (through the MeProvider) or stub `fetch` on `/api/me`; both want the same `Me` object, so it
 * lives here. `signedInMe` builds a session user with a derived status; `anonymousMe` is the signed-out
 * answer. Override any field a test asserts on.
 */
import type { Me, MeUser, UserStatus } from '../../src/api/client.js'

/** A signed-in `/api/me` answer for a user with the given id and derived status (default `normal`). */
export function signedInMe(
  id = 'dev-user',
  status: UserStatus = 'normal',
  overrides: Partial<MeUser> = {},
): Me {
  return {
    user: {
      id,
      name: id,
      email: `${id}@test.local`,
      image: null,
      github_username: null,
      status,
      ...overrides,
    },
  }
}

/** The signed-out `/api/me` answer: no user. */
export const anonymousMe: Me = { user: null }
