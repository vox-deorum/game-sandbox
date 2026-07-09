import {
  type APIRequest,
  type APIRequestContext,
  test as base,
  expect,
  type Page,
} from '@playwright/test'

import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  emailFor,
  MEMBER_PASSWORD,
  type MemberStatus,
  ROLE_BY_STATUS,
  signInEmail,
} from './auth.js'

/**
 * The suite's authentication fixtures. The backend resolves identity from a Better Auth session
 * cookie, so acting as a user means holding that user's cookie — not sending a header. Each fixture
 * hands back an `APIRequestContext` whose cookie jar already carries a signed-in session, so a spec
 * composes flows by choosing which context to act through:
 *
 * - `admin` is the seeded bootstrap admin, the actor for every `/api/admin/*` and roster call.
 * - `as(handle)` lazily creates a member account (default status `normal`) and returns a context
 *   signed in as it — the actor for owner submissions, ratings, and member session starts.
 *
 * Both share the current project's `baseURL`, so their cookies match the origin the browser loads
 * from and can be copied onto a browser context with {@link authenticateBrowser}.
 */

/** A factory that returns a signed-in member context, creating the account on first use. */
export type As = (handle: string, opts?: { status?: MemberStatus }) => Promise<APIRequestContext>

interface AuthFixtures {
  admin: APIRequestContext
  as: As
}

/** Open a fresh API context on `baseURL` and sign it in, so its jar carries the session cookie. */
async function signedInContext(
  request: APIRequest,
  baseURL: string,
  email: string,
  password: string,
): Promise<APIRequestContext> {
  // Better Auth's admin-plugin routes (create-user, set-role, ban, …) reject a state-changing request
  // whose `Origin` is missing or untrusted. A browser sends `Origin` automatically; a bare API context
  // does not, so pin it to `baseURL`, which is the server's `PUBLIC_ORIGIN` and therefore trusted.
  const ctx = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } })
  await signInEmail(ctx, email, password)
  return ctx
}

export const test = base.extend<AuthFixtures>({
  admin: async ({ playwright, baseURL }, use) => {
    const ctx = await signedInContext(
      playwright.request,
      baseURL as string,
      ADMIN_EMAIL,
      ADMIN_PASSWORD,
    )
    await use(ctx)
    await ctx.dispose()
  },

  as: async ({ playwright, baseURL, admin }, use) => {
    // Keyed by handle alone: a handle's account (and role) is fixed by the first `create-user` that
    // wins on the shared per-run database, so the suite gives each handle a single status per run. A
    // later `as(handle, { status })` with a different status would not change the persisted role, so
    // that combination is deliberately not used.
    const cache = new Map<string, APIRequestContext>()
    const factory: As = async (handle, opts = {}) => {
      const status = opts.status ?? 'normal'
      const cached = cache.get(handle)
      if (cached !== undefined) {
        return cached
      }
      // Create the roster account. On the shared per-run database the handle may already exist from an
      // earlier spec; the admin plugin rejects that with a duplicate-email error before touching the
      // existing row, so tolerate exactly that case. Any other failure (a bad role, a lapsed admin
      // session) surfaces here rather than resurfacing one step later as a vaguer sign-in error.
      const created = await admin.post('/api/auth/admin/create-user', {
        data: {
          email: emailFor(handle),
          password: MEMBER_PASSWORD,
          name: handle,
          role: ROLE_BY_STATUS[status],
        },
      })
      if (!created.ok()) {
        const body = await created.text()
        if (!/exist/i.test(body)) {
          expect(
            created.ok(),
            `create-user ${handle} failed (${created.status()}): ${body}`,
          ).toBeTruthy()
        }
      }
      const ctx = await signedInContext(
        playwright.request,
        baseURL as string,
        emailFor(handle),
        MEMBER_PASSWORD,
      )
      cache.set(handle, ctx)
      return ctx
    }
    await use(factory)
    for (const ctx of cache.values()) {
      await ctx.dispose()
    }
  },
})

export { expect }

/**
 * Sign in through the real `/login` form and wait for the post-sign-in navigation home. Used by the
 * authentication journeys that exercise the login UI itself; specs that only need an authenticated
 * browser for other coverage inject the cookie with {@link authenticateBrowser} instead, which is
 * faster and does not re-test the form.
 */
export async function signInThroughUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // LoginPage does a full `window.location.assign('/')` on success, so wait for the home path rather
  // than an SPA route change.
  await page.waitForURL((url) => url.pathname === '/')
}
