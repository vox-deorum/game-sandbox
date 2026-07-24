import { authenticateBrowser } from './support/auth.js'
import { expect, test } from './support/fixtures.js'
import { SPECTATOR } from './support/names.js'

/**
 * The watch and spectator variations. Watch starts a scripted session where the built-in agent plays
 * into the same renderer with no input controls for the user. A second browser context opening the
 * session URL is a spectator: it sees the states stream but has no controls, mirroring the protocol's
 * owner-only authority rule. Needs a Docker daemon (a real scripted session runs).
 */
test('watch a scripted session, and a spectator gets no controls', async ({
  page,
  browser,
  admin,
  as,
}) => {
  // Browse as the operator, so this session's owner controls (Stop/Pause) are the browser's own.
  await authenticateBrowser(page.context(), admin)

  await page.goto('/environments/flappy_bird')
  // The built-in Naive agent is pinned atop the watch list; its Watch button starts a scripted run.
  const builtinRow = page.locator('.agent-row').filter({ hasText: 'Naive agent' })
  await builtinRow.getByRole('button', { name: 'Watch' }).click()
  const dialog = page.getByRole('dialog', { name: /Watch Flappy Bird/ })
  await expect(dialog.getByLabel('Pipe gap')).toHaveValue('100')
  await dialog.getByLabel('Pipe gap').fill('110')
  await dialog.getByRole('button', { name: 'Start watching' }).click()

  await expect(page).toHaveURL(/\/sessions\//)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible()
  const sessionUrl = page.url()

  // A scripted session's owner gets controls (stop) but no input window (no controlled slot).
  await expect(page.getByText(/Per-step input window/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
  // Hold the scripted run open before a second context attaches. The built-in agent can naturally
  // finish very quickly on CI, which would turn the spectator assertion into an ended-session race.
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.overlay-banner')).toHaveText('Paused')

  // A second context opening the same URL is a spectator: the renderer draws, but no controls appear.
  // It must act as a different user, or it would share the owner's session cookie and get the owner's
  // controls; signing it in as a separate member (created on first use) gives it one.
  const spectatorContext = await browser.newContext()
  await authenticateBrowser(spectatorContext, await as(SPECTATOR))
  const spectator = await spectatorContext.newPage()
  await spectator.goto(sessionUrl)
  await expect(spectator.locator('canvas.renderer-canvas')).toBeVisible()
  await expect(spectator.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await expect(spectator.getByRole('button', { name: 'Pause' })).toHaveCount(0)
  await spectatorContext.close()

  // Clean up the live session. The scripted game can end on its own before this point (the agent
  // plays a real game), so stop only a still-running session; either way it ends into its terminal
  // state, which the bar marks by surfacing the replay link.
  const stop = page.getByRole('button', { name: 'Stop' })
  if (await stop.isVisible()) {
    // The game can also end between the visibility check and the click; the ended-state assertion
    // below is the real check either way.
    await stop.click({ timeout: 5000 }).catch(() => {})
  }
  await expect(page.getByRole('link', { name: 'Open replay' })).toBeVisible()
})
