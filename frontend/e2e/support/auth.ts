import { type APIRequestContext, type BrowserContext, expect } from '@playwright/test'

/**
 * Better Auth credentials for the e2e suite.
 *
 * The backend embeds Better Auth (Stage 12): identity is a session cookie, not the old mock
 * request header. Both e2e servers opt into the published insecure development defaults
 * (see playwright.config.ts), so the one login the backend seeds is the bootstrap admin below.
 * Every other persona in `names.ts` is a real account this suite creates through the admin roster
 * endpoint and then signs in as (see the `admin` / `as` fixtures in `fixtures.ts`).
 */

/**
 * The bootstrap admin the backend seeds under `AUTH_ALLOW_INSECURE_DEFAULTS`. These are the
 * published development credentials (`DEV_ADMIN_EMAIL` / `DEV_ADMIN_PASSWORD` in
 * backend/src/config/config.ts). `npm run demo` prints the same pair, so scripts/demo.py must keep the
 * values in sync.
 */
export const ADMIN_EMAIL = 'admin@example.com'
export const ADMIN_PASSWORD = 'admin-dev-password'

/**
 * The shared password every member account this suite creates signs in with. `npm run demo`
 * prints this alongside `ada-lovelace`'s email, so scripts/demo.py must keep the value in sync
 * (`_MEMBER_PASSWORD` there).
 */
export const MEMBER_PASSWORD = 'e2e-member-password'

/** Every created member's status maps to the single scalar Better Auth role the admin plugin writes. */
export type MemberStatus = 'normal' | 'pending' | 'admin'

/** Map a participation status to the Better Auth role `create-user` / `set-role` take. */
export const ROLE_BY_STATUS: Record<MemberStatus, 'user' | 'pending' | 'admin'> = {
  normal: 'user',
  pending: 'pending',
  admin: 'admin',
}

/**
 * The email a persona handle signs in with. The handle itself stays the account's display name and
 * public identity (the leaderboard row and `/agents/<handle>` profile), so it reads like real data;
 * the `@e2e.local` address is only the login credential.
 */
export function emailFor(handle: string): string {
  return `${handle}@e2e.local`
}

/**
 * Copy a signed-in API context's session cookie onto a browser context, so the browser browses as
 * that user without driving the login form. Clears first, so a mid-test identity swap (e.g. operator
 * to a member) replaces the cookie cleanly rather than layering a second session on top. Call before
 * the context's first navigation, so the SPA's one `/api/me` fetch at load already sees the user.
 */
export async function authenticateBrowser(
  context: BrowserContext,
  api: APIRequestContext,
): Promise<void> {
  const { cookies } = await api.storageState()
  await context.clearCookies()
  await context.addCookies(cookies)
}

/** Sign a bare API context in over HTTP, asserting success with the server's reason on failure. */
export async function signInEmail(
  ctx: APIRequestContext,
  email: string,
  password: string,
): Promise<void> {
  const res = await ctx.post('/api/auth/sign-in/email', { data: { email, password } })
  expect(res.ok(), `sign-in ${email} failed (${res.status()}): ${await res.text()}`).toBeTruthy()
}

/**
 * The Better Auth user id of the account a signed-in context holds. A member's public identity is now
 * this opaque id, not its handle (the handle is only the display name), so a profile lives at
 * `/environments/<env>/agents/<userId>` and attribution rows carry this id — a spec that navigates to
 * an owner's profile resolves the id through here rather than reusing the handle.
 */
export async function userIdOf(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.get('/api/me')
  expect(res.ok(), `GET /api/me failed (${res.status()}): ${await res.text()}`).toBeTruthy()
  const body = (await res.json()) as { user: { id: string } | null }
  expect(body.user, 'expected a signed-in user').not.toBeNull()
  return (body.user as { id: string }).id
}
