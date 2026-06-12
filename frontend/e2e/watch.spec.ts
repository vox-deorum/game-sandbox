import { expect, test } from '@playwright/test'

/**
 * The watch and spectator variations. Watch starts a scripted session where the built-in agent plays
 * into the same renderer with no input controls for the user. A second browser context opening the
 * session URL is a spectator: it sees the states stream but has no controls, mirroring the protocol's
 * owner-only authority rule. Needs a Docker daemon (a real scripted session runs).
 */
test('watch a scripted session, and a spectator gets no controls', async ({ page, browser }) => {
  await page.goto('/environments/flappy_bird')
  await page.getByRole('button', { name: 'Watch' }).click()
  await page.getByRole('button', { name: 'Start watching' }).click()

  await expect(page).toHaveURL(/\/sessions\//)
  await expect(page.locator('canvas.flappy-canvas')).toBeVisible()
  const sessionUrl = page.url()

  // A scripted session's owner gets controls (stop) but no input window (no controlled slot).
  await expect(page.getByText(/Per-step input window/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()

  // A second context opening the same URL is a spectator: the renderer draws, but no controls appear.
  const spectatorContext = await browser.newContext()
  const spectator = await spectatorContext.newPage()
  await spectator.goto(sessionUrl)
  await expect(spectator.locator('canvas.flappy-canvas')).toBeVisible()
  await expect(spectator.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await expect(spectator.getByRole('button', { name: 'Pause' })).toHaveCount(0)
  await spectatorContext.close()

  // Clean up the live session.
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.end-card')).toBeVisible()
})
