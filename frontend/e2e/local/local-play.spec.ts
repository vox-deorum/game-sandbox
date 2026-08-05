import { expect, type Locator, test } from '@playwright/test'

const LOCAL_PLAY_URL = 'http://127.0.0.1:8091/local.html'

async function readCanvasDensity(canvas: Locator) {
  return canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const rect = canvas.getBoundingClientRect()
    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      dpr: window.devicePixelRatio,
      widthError: Math.abs(canvas.width - rect.width * window.devicePixelRatio),
      heightError: Math.abs(canvas.height - rect.height * window.devicePixelRatio),
    }
  })
}

async function expectBackingDensity(canvas: Locator): Promise<void> {
  await expect
    .poll(async () => {
      const density = await readCanvasDensity(canvas)
      return Math.max(density.widthError, density.heightError)
    })
    .toBeLessThanOrEqual(1)
}

/**
 * The local browser journey runs against the loopback-only Python relay and standalone Vite bundle.
 * The scripted runner makes input forwarding deterministic while exercising the same JSON-lines and
 * WebSocket contracts as a real template episode.
 */
test('local play starts, reconnects while paused, and reaches a stopped terminal state', async ({
  page,
}) => {
  await page.goto(LOCAL_PLAY_URL)
  await expect(page.getByRole('heading', { name: 'Flappy Bird' })).toBeVisible()
  const canvas = page.locator('canvas.renderer-canvas')
  await expect(canvas).toBeVisible()

  // Flappy's 288 × 512 internal space is deliberately enlarged by the host. The backing store must
  // follow the displayed canvas, not that logical coordinate system, with one pixel of rounding room.
  const density = await readCanvasDensity(canvas)
  expect(density.cssWidth).toBeGreaterThan(288)
  expect(Math.max(density.widthError, density.heightError)).toBeLessThanOrEqual(1)

  // A post-mount viewport resize changes the host, so the observer's debounced resize must rebuild
  // the canvas backing store after the displayed width changes.
  await page.setViewportSize({ width: 320, height: 900 })
  await expect
    .poll(async () => {
      const resized = await readCanvasDensity(canvas)
      return Math.abs(resized.cssWidth - density.cssWidth)
    })
    .toBeGreaterThan(1)
  await expectBackingDensity(canvas)

  // Moving to a display with a different DPR does not resize the host. The media-query observer must
  // still rebuild Pixi's backing store to the new density.
  const cdp = await page.context().newCDPSession(page)
  const beforeDprChange = await readCanvasDensity(canvas)
  const initialDpr = await page.evaluate(() => window.devicePixelRatio)
  const changedDpr = initialDpr === 2 ? 1 : 2
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 900,
      deviceScaleFactor: changedDpr,
      mobile: false,
    })
    await expect.poll(async () => (await readCanvasDensity(canvas)).dpr).toBe(changedDpr)
    await expectBackingDensity(canvas)
    const afterDprChange = await readCanvasDensity(canvas)
    expect(Math.abs(afterDprChange.cssWidth - beforeDprChange.cssWidth)).toBeLessThanOrEqual(1)
    expect(Math.abs(afterDprChange.cssHeight - beforeDprChange.cssHeight)).toBeLessThanOrEqual(1)
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await page.setViewportSize({ width: 320, height: 900 })
  }

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
  await expect(page.getByText('Stopped')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Game over' })).toHaveCount(0)
})
