import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  authenticateBrowser,
  emailFor,
  MEMBER_PASSWORD,
} from './support/auth.js'
import { expect, signInThroughUi, test } from './support/fixtures.js'
import { ENV_ID } from './support/names.js'

/**
 * The authentication journeys (Stage 12.5), the executable form of the stage's experiential criteria
 * for the Better Auth foundation: an operator's sign-in/sign-out round trip and the admin-only nav it
 * gates, the admin roster creating an account a newcomer then signs into and plays with, the
 * pending-account gate that only lifts once an admin approves it, and the ban lifecycle — banning a
 * member revokes their live session and refuses their sign-in until an admin unbans them. Only
 * journey 2 starts a session (a real container), so this file rides the Docker-gated `frontend-e2e`
 * job with the rest of the suite.
 */

test('an admin signs in, sees the admin nav, and signs out', async ({ page }) => {
  await signInThroughUi(page, ADMIN_EMAIL, ADMIN_PASSWORD)

  // AppSidebar appends the roster link only when isAdmin(me) is true (see its `items` computed) — the
  // one admin-only affordance the sidebar itself carries; the operator console tab lives per-game in
  // ExperimentTabs instead.
  await expect(page.getByRole('link', { name: 'Users' })).toBeVisible()

  // AccountMenu's "Log out" ends the Better Auth session, then does a full navigation to /login so the
  // one /api/me fetch re-runs and the shell renders signed-out.
  await page.getByRole('button', { name: 'Log out' }).click()
  await page.waitForURL((url) => url.pathname === '/login')

  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0)
})

test('an admin creates a user, who signs in and plays', async ({ page, browser, admin }) => {
  // A dialog-driven account creation plus a real self-play session start comfortably eats into the
  // default 60s window once a second real sign-in and a container launch stack on top.
  test.setTimeout(90_000)

  const name = 'journey-newcomer'
  const email = emailFor(name)

  // Browse as the operator so the roster page's create dialog is reachable.
  await authenticateBrowser(page.context(), admin)
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Create user' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(MEMBER_PASSWORD)
  // The dialog's Role select already defaults to "User" (normal participation) — leave it untouched.
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The new account is a separate identity: sign it in through the real form in its own browser
  // context, rather than copying the admin's cookie onto it.
  const newcomerContext = await browser.newContext()
  const newcomerPage = await newcomerContext.newPage()
  try {
    await signInThroughUi(newcomerPage, email, MEMBER_PASSWORD)

    await newcomerPage.goto('/')
    await newcomerPage.getByRole('link', { name: /Flappy Bird/ }).click()
    await newcomerPage.getByRole('button', { name: 'Play', exact: true }).click()
    await newcomerPage.getByRole('button', { name: 'Start playing' }).click()

    // The session page mounts the renderer — the same live-session proof journey.spec asserts on.
    await expect(newcomerPage).toHaveURL(/\/sessions\//)
    await expect(newcomerPage.locator('canvas.renderer-canvas')).toBeVisible()
  } finally {
    // Clean up the live session before tearing down its context; the paced game may also have already
    // ended it on its own, so stop only a still-running session.
    const stop = newcomerPage.getByRole('button', { name: 'Stop' })
    if (await stop.isVisible()) {
      await stop.click({ timeout: 5000 }).catch(() => {})
    }
    await newcomerContext.close()
  }
})

test('a pending user is gated until an admin approves them', async ({
  page,
  browser,
  admin,
  as,
}) => {
  await as('pending-journey', { status: 'pending' })
  const pendingEmail = emailFor('pending-journey')

  const pendingContext = await browser.newContext()
  const pendingPage = await pendingContext.newPage()
  try {
    await signInThroughUi(pendingPage, pendingEmail, MEMBER_PASSWORD)

    await pendingPage.goto(`/environments/${ENV_ID}`)
    // AppShell shows this role="status" banner while the account is pending (me.ts's canParticipate is
    // false for that status). EnvironmentPage's "Play" button only renders at all once canParticipate
    // is true (`v-if="canStartHumanPlay"`), so a pending account never sees the button in any
    // state — there is no separate disabled affordance to assert against, only its absence.
    // Target the banner by its copy: other components on the environment page also carry role="status",
    // so a bare getByRole('status') would be ambiguous.
    const pendingBanner = pendingPage.getByText('Your account is awaiting approval.')
    await expect(pendingBanner).toBeVisible()
    await expect(pendingPage.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0)

    // Approve the account as the admin, in the separate `page` browser context.
    await authenticateBrowser(page.context(), admin)
    await page.goto('/admin/users')
    await page.getByLabel('Search users').fill(pendingEmail)
    const row = page.getByRole('row').filter({ hasText: pendingEmail })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Approve' }).click()
    await expect(row.getByRole('button', { name: 'Approve' })).toHaveCount(0)

    // The SPA fetches /api/me once at load, so the approval only reaches the pending user's
    // already-open tab on its next navigation — reload to pick it up.
    await pendingPage.reload()
    await expect(pendingPage.getByText('Your account is awaiting approval.')).toHaveCount(0)
    await expect(pendingPage.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  } finally {
    await pendingContext.close()
  }
})

test('a banned member loses their session and cannot sign back in until unbanned', async ({
  page,
  browser,
  admin,
  as,
}) => {
  // Deliberately reuse the account journey 2 created rather than adding another persona to the shared
  // roster; the `as` fixture creates it if this test runs alone. The signed-in context it returns is
  // itself a live session the ban must revoke.
  const handle = 'journey-newcomer'
  const memberEmail = emailFor(handle)
  const member = await as(handle)

  const memberContext = await browser.newContext()
  const memberPage = await memberContext.newPage()
  try {
    // The member browses signed in — the session the ban is about to end.
    await authenticateBrowser(memberContext, member)
    await memberPage.goto('/')
    await expect(memberPage.getByRole('button', { name: 'Log out' })).toBeVisible()

    // The admin bans them through the roster's ban dialog, with a reason.
    await authenticateBrowser(page.context(), admin)
    await page.goto('/admin/users')
    await page.getByLabel('Search users').fill(memberEmail)
    const row = page.getByRole('row').filter({ hasText: memberEmail })
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Ban' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Reason (optional)').fill('Conduct review')
    await dialog.getByRole('button', { name: 'Ban' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(row.getByText('Banned')).toBeVisible()

    // The Banned status tab's filter also finds them (the search box still narrows to this account).
    await page.getByRole('tab', { name: 'Banned' }).click()
    await expect(row).toBeVisible()

    // Better Auth revoked the member's sessions with the ban, so their next load renders signed out.
    await memberPage.reload()
    await expect(memberPage.getByRole('link', { name: 'Sign in' })).toBeVisible()

    // Signing back in is refused with the ban message, not a generic credential error.
    await memberPage.goto('/login')
    await memberPage.getByLabel('Email').fill(memberEmail)
    await memberPage.getByLabel('Password').fill(MEMBER_PASSWORD)
    await memberPage.getByRole('button', { name: 'Sign in' }).click()
    await expect(memberPage.getByRole('alert')).toContainText(/banned/i)

    // Unban from the Banned tab: the row leaves the banned filter...
    await row.getByRole('button', { name: 'Unban' }).click()
    await expect(row).toHaveCount(0)

    // ...and the member can sign in again. This also restores the shared roster for later specs and
    // the demo fixture, which serve this same database.
    await signInThroughUi(memberPage, memberEmail, MEMBER_PASSWORD)
    await expect(memberPage.getByRole('button', { name: 'Log out' })).toBeVisible()
  } finally {
    await memberContext.close()
  }
})
