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
 * The three authentication journeys (Stage 12.5), the executable form of the stage's experiential
 * criteria for the Better Auth foundation: an operator's sign-in/sign-out round trip and the admin-only
 * nav it gates, the admin roster creating an account a newcomer then signs into and plays with, and the
 * pending-account gate that only lifts once an admin approves it. Journeys 1 and 3 never start a
 * session; journey 2 does (a real container), so this file rides the Docker-gated `frontend-e2e` job
 * with the rest of the suite.
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
    await newcomerPage.getByRole('button', { name: 'Play Yourself' }).click()
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
    // false for that status). EnvironmentPage's "Play Yourself" only renders at all once canParticipate
    // is true (`v-if="canStartHumanPlay"`), so a pending account never sees the button in any
    // state — there is no separate disabled affordance to assert against, only its absence.
    // Target the banner by its copy: other components on the environment page also carry role="status",
    // so a bare getByRole('status') would be ambiguous.
    const pendingBanner = pendingPage.getByText('Your account is awaiting approval.')
    await expect(pendingBanner).toBeVisible()
    await expect(pendingPage.getByRole('button', { name: 'Play Yourself' })).toHaveCount(0)

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
    await expect(pendingPage.getByRole('button', { name: 'Play Yourself' })).toBeVisible()
  } finally {
    await pendingContext.close()
  }
})
