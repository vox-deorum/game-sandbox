import type { BrowserContext, Page } from '@playwright/test'

import { startSession, stopSessionAndAwaitFree } from '../support/api.js'
import { authenticateBrowser } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'
import { SPECTATOR, SPECTATOR_TWO } from '../support/names.js'

const ENV_ID = 'three_branches'
const FITTED_CAMERA = '0.58@800,800'
const CHROME_HEIGHT = 54
const CONTENT_HEIGHT = 1_000 - CHROME_HEIGHT
const FIRST_RECORDED_TICK = 2

// Keep the seed, tick, and text together so the watch and watcher journeys exercise the same
// deterministic opening with the moving Naive cast.
const VISITOR_CHAT_SEED = 22
const VISITOR_FIRST_LINE_TICK = 105
const VISITOR_FIRST_LINE = 'A fine day for walking. How are you?'

interface CameraProbe {
  zoom: number
  x: number
  y: number
}

function cameraProbe(value: string | null): CameraProbe {
  const match = /^(\d+(?:\.\d+)?)@(-?\d+),(-?\d+)$/.exec(value ?? '')
  if (match === null) throw new Error(`Unexpected Three Branches camera probe: ${value}`)
  return { zoom: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
}

function assertCameraClamped(camera: CameraProbe): void {
  const bounds = { min: -20, max: 1_620 }
  const halfWidth = 600 / camera.zoom
  const halfHeight = CONTENT_HEIGHT / (2 * camera.zoom)
  expect(camera.x).toBeGreaterThanOrEqual(Math.ceil(bounds.min + halfWidth) - 1)
  expect(camera.x).toBeLessThanOrEqual(Math.floor(bounds.max - halfWidth) + 1)
  expect(camera.y).toBeGreaterThanOrEqual(Math.ceil(bounds.min + halfHeight) - 1)
  expect(camera.y).toBeLessThanOrEqual(Math.floor(bounds.max - halfHeight) + 1)
}

async function rendererCanvas(page: Page) {
  const canvas = page.locator('canvas.renderer-canvas')
  await expect(canvas).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(() => canvas.evaluate((element) => element.width * element.height))
    .toBeGreaterThan(0)
  return canvas
}

async function paintedGroundPixel(page: Page, canvas: Awaited<ReturnType<typeof rendererCanvas>>) {
  // Seed 22 leaves this screen point over an unoccluded ground tile. Screenshot pixels are the
  // compositor's painted result. WebGL's default drawing buffer is intentionally transient, so
  // readPixels would test an implementation detail instead of the view.
  const image = (await canvas.screenshot()).toString('base64')
  return page.evaluate(async (encoded) => {
    const screenshot = new Image()
    screenshot.src = `data:image/png;base64,${encoded}`
    await screenshot.decode()
    const scratch = document.createElement('canvas')
    scratch.width = screenshot.naturalWidth
    scratch.height = screenshot.naturalHeight
    const context = scratch.getContext('2d')
    if (context === null)
      throw new Error('A 2D canvas is required to inspect the renderer screenshot.')
    context.drawImage(screenshot, 0, 0)
    const x = Math.floor((143 / 1_200) * scratch.width)
    const y = Math.floor((70 / 1_000) * scratch.height)
    return [...context.getImageData(x, y, 1, 1).data]
  }, image)
}

function isOpenGroundPixel(pixel: number[]): boolean {
  const expected = [169, 130, 98, 255]
  return (
    pixel.length === expected.length &&
    pixel.every((channel, index) => Math.abs(channel - (expected[index] ?? 0)) <= 6)
  )
}

test('watch a Three Branches day, explore collision truth, and seek its exact replay frames', async ({
  page,
  admin,
}) => {
  test.setTimeout(120_000)
  let sessionId: string | null = null

  try {
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/environments/${ENV_ID}`)
    const scriptedVisitor = page.locator('.agent-row--builtin', { hasText: 'Scripted visitor' })
    await scriptedVisitor.getByRole('button', { name: 'Watch' }).click()

    const dialog = page.getByRole('dialog', { name: /Watch Days at Three Branches/ })
    const preset = dialog.getByRole('combobox', { name: 'Preset' })
    await preset.selectOption('season_1')
    await dialog
      .getByRole('spinbutton', { name: 'Seed (optional)' })
      .fill(String(VISITOR_CHAT_SEED))
    await dialog.getByRole('button', { name: 'Start watching' }).click()
    await expect(page).toHaveURL(/\/sessions\//)
    sessionId = page.url().split('/').at(-1) ?? null
    if (sessionId === null) throw new Error('Three Branches watch did not provide a session id')

    const canvas = await rendererCanvas(page)
    const rendererHost = page.locator('.renderer-host')
    await expect(rendererHost).toHaveAttribute('data-three-branches-ground', 'ready')
    await expect(rendererHost).toHaveAttribute('data-three-branches-opening', 'seen')
    await expect(rendererHost).toHaveAttribute('data-three-branches-camera', FITTED_CAMERA)
    await expect
      .poll(async () => isOpenGroundPixel(await paintedGroundPixel(page, canvas)))
      .toBe(true)

    await expect
      .poll(async () => Number(await rendererHost.getAttribute('data-three-branches-tick')))
      .toBeGreaterThanOrEqual(1)
    const openingTick = Number(await rendererHost.getAttribute('data-three-branches-tick'))
    await expect
      .poll(async () => Number(await rendererHost.getAttribute('data-three-branches-tick')))
      .toBeGreaterThan(openingTick)

    const canvasBox = await canvas.boundingBox()
    expect(canvasBox).not.toBeNull()
    if (canvasBox === null) throw new Error('Three Branches canvas has no browser bounds')
    const center = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 }

    await page.mouse.move(center.x, center.y)
    await page.mouse.wheel(0, -1_000)
    await expect
      .poll(
        async () => cameraProbe(await rendererHost.getAttribute('data-three-branches-camera')).zoom,
      )
      .toBeGreaterThan(cameraProbe(FITTED_CAMERA).zoom)

    const zoomed = cameraProbe(await rendererHost.getAttribute('data-three-branches-camera'))
    await page.mouse.move(center.x, center.y)
    await page.mouse.down()
    await page.mouse.move(center.x + 10_000, center.y + 10_000)
    await page.mouse.up()
    await expect
      .poll(
        async () => cameraProbe(await rendererHost.getAttribute('data-three-branches-camera')).x,
      )
      .not.toBe(zoomed.x)
    assertCameraClamped(cameraProbe(await rendererHost.getAttribute('data-three-branches-camera')))

    // The Pixi control lives in the renderer's logical 1200 by 1000 canvas, so drive it through the
    // painted button rather than a DOM-only stand-in.
    await canvas.click({
      position: { x: (1_070 / 1_200) * canvasBox.width, y: (27 / 1_000) * canvasBox.height },
    })
    await expect(rendererHost).toHaveAttribute('data-three-branches-collision', 'off')

    await page.getByRole('button', { name: 'Stop' }).click()
    const replayLink = page.getByRole('link', { name: 'Open replay' })
    await expect(replayLink).toBeVisible({ timeout: 60_000 })
    await replayLink.click()
    await expect(page).toHaveURL(/\/replays\//)
    await rendererCanvas(page)

    const replayHost = page.locator('.renderer-host')
    await expect(replayHost).toHaveAttribute('data-three-branches-ground', 'ready')
    await expect(replayHost).toHaveAttribute(
      'data-three-branches-tick',
      String(FIRST_RECORDED_TICK),
    )
    await expect(replayHost).toHaveAttribute('data-three-branches-camera', FITTED_CAMERA)

    const slider = page.getByRole('slider', { name: 'Replay position' })
    await slider.press('Home')
    await slider.press('ArrowRight')
    const firstSeek = {
      tick: await replayHost.getAttribute('data-three-branches-tick'),
      visitor: await replayHost.getAttribute('data-three-branches-visitor'),
    }
    await slider.press('End')
    await slider.press('Home')
    await slider.press('ArrowRight')
    await expect(replayHost).toHaveAttribute('data-three-branches-tick', firstSeek.tick ?? '')
    await expect(replayHost).toHaveAttribute('data-three-branches-visitor', firstSeek.visitor ?? '')
  } finally {
    if (sessionId !== null) await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
  }
})

test('Three Branches watchers see the greeting live and its recording survives reconnect', async ({
  page,
  browser,
  admin,
  as,
}) => {
  test.setTimeout(120_000)
  let sessionId: string | null = null
  let spectatorContext: BrowserContext | null = null
  let spectatorTwoContext: BrowserContext | null = null

  try {
    sessionId = await startSession(
      admin,
      ENV_ID,
      {
        seat_0: { kind: 'builtin-agent', name: 'naive' },
        seat_1: { kind: 'builtin-agent', name: 'scripted_visitor' },
      },
      {
        seed: VISITOR_CHAT_SEED,
        parameters: { seat_plan: 'cast_5', daynight: false },
      },
    )
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/sessions/${sessionId}`)
    await rendererCanvas(page)

    spectatorContext = await browser.newContext()
    await authenticateBrowser(spectatorContext, await as(SPECTATOR))
    const spectator = await spectatorContext.newPage()
    await spectator.goto(page.url())
    await rendererCanvas(spectator)
    const spectatorChat = spectator.getByRole('group', { name: 'Chat log' })
    await expect(spectatorChat).toBeVisible()
    await expect(spectatorChat.getByRole('textbox')).toHaveCount(0)

    spectatorTwoContext = await browser.newContext()
    await authenticateBrowser(spectatorTwoContext, await as(SPECTATOR_TWO))
    const spectatorTwo = await spectatorTwoContext.newPage()
    await spectatorTwo.goto(page.url())
    await rendererCanvas(spectatorTwo)
    const spectatorTwoChat = spectatorTwo.getByRole('group', { name: 'Chat log' })
    await expect(spectatorTwoChat).toBeVisible()
    await expect(spectatorTwoChat.getByRole('textbox')).toHaveCount(0)

    await expect(spectatorChat.getByText(VISITOR_FIRST_LINE, { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(spectatorTwoChat.getByText(VISITOR_FIRST_LINE, { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    const visitorLine = spectatorChat.locator('.chat-entry', { hasText: VISITOR_FIRST_LINE })
    await expect(visitorLine.locator('.chat-player')).toHaveText('P0')
    await expect(visitorLine.getByText('to P2', { exact: true })).toBeVisible()
    await expect(spectatorChat.locator('.chat-tick')).toContainText(
      `tick ${VISITOR_FIRST_LINE_TICK}`,
    )

    await spectator.reload()
    const reloadedChat = spectator.getByRole('group', { name: 'Chat log' })
    await expect(reloadedChat).toBeVisible({ timeout: 30_000 })
    await expect(reloadedChat.getByRole('textbox')).toHaveCount(0)
    // Live reconnect catch-up is best-effort and retains only the latest state. If that state still
    // carries the greeting, the client must not duplicate it. Replay below is the exact history.
    expect(
      await reloadedChat.locator('.chat-entry', { hasText: VISITOR_FIRST_LINE }).count(),
    ).toBeLessThanOrEqual(1)

    await page.getByRole('button', { name: 'Stop' }).click()
    const replayLink = page.getByRole('link', { name: 'Open replay' })
    await expect(replayLink).toBeVisible({ timeout: 60_000 })
    await replayLink.click()
    await rendererCanvas(page)
    await page.getByRole('slider', { name: 'Replay position' }).press('End')
    const replayThread = page.getByRole('group', { name: 'Game thread' })
    await expect(replayThread.getByText(VISITOR_FIRST_LINE, { exact: true })).toBeVisible()

    await page.goto(`/sessions/${sessionId}`)
    const reopenedChat = page.getByRole('group', { name: 'Chat log' })
    await expect(reopenedChat.getByText(VISITOR_FIRST_LINE, { exact: true })).toBeVisible({
      timeout: 30_000,
    })
    await expect(reopenedChat.locator('.chat-entry', { hasText: VISITOR_FIRST_LINE })).toHaveCount(
      1,
    )
    await expect(reopenedChat.getByRole('textbox')).toHaveCount(0)
  } finally {
    await spectatorContext?.close().catch(() => {})
    await spectatorTwoContext?.close().catch(() => {})
    if (sessionId !== null) await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
  }
})
