import { expect, test } from '@playwright/test'

const LOCAL_PLAY_URL = 'http://127.0.0.1:8091/local.html'

/**
 * The local browser journey runs against the loopback-only Python relay and standalone Vite bundle.
 * The scripted runner makes input forwarding deterministic while exercising the same JSON-lines and
 * WebSocket contracts as a real template episode.
 */
test('local play starts, reconnects while paused, and reaches game over', async ({ page }) => {
  await page.goto(LOCAL_PLAY_URL)
  await expect(page.getByRole('heading', { name: 'Flappy Bird' })).toBeVisible()
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible()

  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
  await expect(page.locator('.overlay-banner')).toHaveCount(0)

  // A keyboard flap crosses the renderer, browser socket, relay, and scripted runner. The returned
  // state records action 1, making the full input path visible in the ordinary decision log.
  await page.keyboard.press('Space')
  const latestDecision = page.locator('.decision-log tbody tr').last()
  await expect(latestDecision.locator('td').nth(1)).toHaveText('2')
  await expect(latestDecision.locator('td').nth(2)).toHaveText('1')

  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.overlay-banner')).toHaveText('Paused')
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.locator('.overlay-banner')).toHaveCount(0)

  // Refreshing closes the first browser socket and attaches a new one. The relay replays its header,
  // latest acted state, running status, and pause echo, so this is Resume rather than a fresh Start.
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.overlay-banner')).toHaveText('Paused')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0)
  await expect(page.locator('.overlay-banner')).toHaveText('Paused')
  await expect(page.locator('.decision-log tbody tr').last().locator('td').nth(2)).toHaveText('1')

  await page.getByRole('button', { name: 'Resume' }).click()
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.getByRole('dialog', { name: 'Game over' })).toBeVisible()
  await expect(page.getByText('Stopped')).toBeVisible()
})
