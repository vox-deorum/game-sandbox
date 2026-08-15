import type { Locator } from '@playwright/test'

import { getSession, startSession, stopSessionAndAwaitFree } from '../support/api.js'
import { authenticateBrowser } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'
import { controlCentre, ENV_ID } from './support.js'

interface CameraProbe {
  zoom: number
  x: number
  y: number
}

interface FrameProbe {
  tick: string
  visitor: string
}

function parseCamera(value: string | null): CameraProbe {
  const match = /^(\d+(?:\.\d+)?)@(-?\d+),(-?\d+)$/.exec(value ?? '')
  if (match === null) throw new Error(`Unexpected Three Branches camera probe: ${value}`)
  return { zoom: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
}

async function readFrameProbe(host: Locator): Promise<FrameProbe> {
  const tick = await host.getAttribute('data-three-branches-tick')
  const visitor = await host.getAttribute('data-three-branches-visitor')
  if (tick === null || visitor === null) throw new Error('Three Branches frame probes are missing')
  return { tick, visitor }
}

test('watch Three Branches, inspect its camera and collision, then repeat a replay seek', async ({
  page,
  admin,
}) => {
  test.setTimeout(120_000)
  await authenticateBrowser(page.context(), admin)

  const sessionId = await startSession(
    admin,
    ENV_ID,
    {
      seat_0: { kind: 'builtin-agent', name: 'naive' },
      seat_1: { kind: 'builtin-agent', name: 'scripted_visitor' },
    },
    { seed: 0 },
  )

  try {
    await page.goto(`/sessions/${sessionId}`)
    const canvas = page.locator('canvas.renderer-canvas')
    const host = page.locator('.renderer-host')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    await expect(host).toHaveAttribute('data-three-branches-ground', 'ready')
    await expect(host).toHaveAttribute('data-three-branches-assets', 'ready')
    await expect(host).toHaveAttribute('data-three-branches-visitor', /^-?\d+,-?\d+$/)
    await expect(host).toHaveAttribute('data-three-branches-camera', /^\d+(?:\.\d+)?@-?\d+,-?\d+$/)
    await expect(host).toHaveAttribute('data-three-branches-collision', 'off')

    const openingTick = Number(await host.getAttribute('data-three-branches-tick'))
    expect(Number.isFinite(openingTick)).toBe(true)
    await expect
      .poll(async () => Number(await host.getAttribute('data-three-branches-tick')))
      .toBeGreaterThan(openingTick)

    const canvasBox = await canvas.boundingBox()
    if (canvasBox === null) throw new Error('Three Branches canvas has no browser bounds')
    const contentPoint = {
      x: canvasBox.x + canvasBox.width / 2,
      y: canvasBox.y + canvasBox.height / 2,
    }
    const initialCamera = parseCamera(await host.getAttribute('data-three-branches-camera'))
    await page.mouse.move(contentPoint.x, contentPoint.y)
    await page.mouse.wheel(0, -400)
    await expect
      .poll(async () => parseCamera(await host.getAttribute('data-three-branches-camera')).zoom)
      .toBeGreaterThan(initialCamera.zoom)

    // The wheel suspended follow, so the camera now holds still while the visitor keeps walking.
    // That makes it the control for both toggles: neither may move the view.
    const inspectedCamera = await host.getAttribute('data-three-branches-camera')
    const inspectedZoom = parseCamera(inspectedCamera).zoom
    const inspectedFrame = await readFrameProbe(host)
    await expect
      .poll(async () => (await readFrameProbe(host)).visitor)
      .not.toBe(inspectedFrame.visitor)
    await expect(host).toHaveAttribute('data-three-branches-camera', inspectedCamera as string)
    const toggleAt = await controlCentre(host, 'data-three-branches-collision-toggle', canvasBox)
    await page.mouse.click(toggleAt.x, toggleAt.y)
    await expect(host).toHaveAttribute('data-three-branches-collision', 'on')
    await expect(host).toHaveAttribute('data-three-branches-camera', inspectedCamera as string)

    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', repeat: true }))
    })
    await expect(host).toHaveAttribute('data-three-branches-collision', 'on')

    await page.locator('body').press('c')
    await expect(host).toHaveAttribute('data-three-branches-collision', 'off')
    await expect(host).toHaveAttribute('data-three-branches-camera', inspectedCamera as string)

    // Recenter preserves the inspected zoom and resumes following, so the view tracks the visitor.
    const recenterAt = await controlCentre(host, 'data-three-branches-recenter', canvasBox)
    await page.mouse.click(recenterAt.x, recenterAt.y)
    await expect
      .poll(async () => parseCamera(await host.getAttribute('data-three-branches-camera')).zoom)
      .toBeCloseTo(inspectedZoom, 3)
    const recentered = await host.getAttribute('data-three-branches-camera')
    await expect
      .poll(async () => host.getAttribute('data-three-branches-camera'))
      .not.toBe(recentered)

    const stop = page.getByRole('button', { name: 'Stop' })
    await expect(stop).toBeVisible()
    await stop.click()
    const openReplay = page.getByRole('link', { name: 'Open replay' })
    await expect(openReplay).toBeVisible({ timeout: 60_000 })
    const ended = await getSession(admin, sessionId)
    if (ended?.recording_id === null || ended?.recording_id === undefined) {
      throw new Error('Three Branches session ended without a recording')
    }

    await openReplay.click()
    await expect(page).toHaveURL(`/replays/${ended.recording_id}`)
    const replayHost = page.locator('.renderer-host')
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    await expect(replayHost).toHaveAttribute('data-three-branches-ground', 'ready')
    await expect(replayHost).toHaveAttribute('data-three-branches-assets', 'ready')
    await expect(replayHost).toHaveAttribute('data-three-branches-visitor', /^-?\d+,-?\d+$/)
    await expect(replayHost).toHaveAttribute(
      'data-three-branches-camera',
      /^\d+(?:\.\d+)?@-?\d+,-?\d+$/,
    )
    await expect(replayHost).toHaveAttribute('data-three-branches-collision', 'off')

    const slider = page.getByRole('slider', { name: 'Replay position' })
    await expect(slider).toBeVisible()
    const lastIndexText = await slider.getAttribute('aria-valuemax')
    if (lastIndexText === null) throw new Error('Three Branches replay has no final index')
    const total = Number(lastIndexText) + 1
    expect(total).toBeGreaterThan(1)

    await slider.focus()
    await slider.press('End')
    await expect(page.locator('.replay-position')).toContainText(`${total}/${total}`)
    const finalProbe = await readFrameProbe(replayHost)

    await slider.press('Home')
    await expect(page.locator('.replay-position')).toContainText(`1/${total}`)
    await slider.press('End')
    await expect(page.locator('.replay-position')).toContainText(`${total}/${total}`)
    await expect.poll(async () => readFrameProbe(replayHost)).toEqual(finalProbe)
  } finally {
    await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
  }
})
