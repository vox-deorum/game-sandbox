import { rmSync } from 'node:fs'

import type { Locator, Page } from '@playwright/test'

import {
  activeWindows,
  closePlay,
  closeSubmissions,
  declareSeason,
  getSession,
  openPlay,
  openSubmissions,
  setSeasonOverrides,
  startSession,
  stopSessionAndAwaitFree,
  submitReadyAgent,
} from '../support/api.js'
import { authenticateBrowser } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'
import { stageExampleAgent } from '../support/stage-example-agent.js'
import { controlCentre, ENV_ID, INTERNAL_SIZE } from './support.js'

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

/** The visitor's landed north-up metre position, from the probe the renderer publishes per frame. */
function parseVisitor(value: string | null): { x: number; y: number } {
  const match = /^(-?\d+),(-?\d+)$/.exec(value ?? '')
  if (match === null) throw new Error(`Unexpected Three Branches visitor probe: ${value}`)
  return { x: Number(match[1]) / 100, y: Number(match[2]) / 100 }
}

/** A logical renderer point converted to browser canvas pixels through the canvas box. */
function canvasPoint(
  canvasBox: { x: number; y: number; width: number; height: number },
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: canvasBox.x + (x / INTERNAL_SIZE.width) * canvasBox.width,
    y: canvasBox.y + (y / INTERNAL_SIZE.height) * canvasBox.height,
  }
}

/** Press and hold the fixed joystick in one drag direction, in logical renderer units. */
async function holdJoystick(
  page: Page,
  host: Locator,
  canvasBox: { x: number; y: number; width: number; height: number },
  dx: number,
  dy: number,
): Promise<void> {
  const probe = await host.getAttribute('data-three-branches-joystick')
  if (probe === null) throw new Error('Three Branches joystick probe is missing')
  const [x, y] = probe.split(',').map(Number)
  if (![x, y].every((value) => Number.isFinite(value))) {
    throw new Error(`Three Branches joystick probe is invalid: ${probe}`)
  }
  const center = canvasPoint(canvasBox, x, y)
  // Drag well past the dead zone for full speed; the joystick saturates at its ring.
  const target = canvasPoint(canvasBox, x + dx, y + dy)
  await page.mouse.move(center.x, center.y)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y)
}

test('watch Three Branches, inspect its camera and collision, then repeat a replay seek', async ({
  page,
  admin,
  as,
}) => {
  test.setTimeout(300_000)
  await authenticateBrowser(page.context(), admin)

  const stagedDir = stageExampleAgent(ENV_ID, 'neighbor')
  let sessionId: string | null = null

  try {
    // The complete e2e database is the npm demo fixture. Replace the seeded windows and deliberately
    // leave Village Life open so the printed student account can run its ready neighbor submission.
    const originalWindows = await activeWindows(admin, ENV_ID)
    if (originalWindows.submissionSeasonId !== null) {
      await closeSubmissions(admin, originalWindows.submissionSeasonId)
    }
    if (originalWindows.playSeasonId !== null) {
      await closePlay(admin, originalWindows.playSeasonId)
    }

    const season = await declareSeason(admin, 'Village Life', ENV_ID)
    await setSeasonOverrides(admin, season.id, {
      parameters: { seat_plan: 'cast_10', daynight: true },
    })
    await openSubmissions(admin, season.id)
    await openPlay(admin, season.id)
    const submissionId = await submitReadyAgent(await as('ada-lovelace'), stagedDir, ENV_ID)
    sessionId = await startSession(
      admin,
      ENV_ID,
      {
        seat_0: { kind: 'submission', submission_id: submissionId },
        seat_1: { kind: 'builtin-agent', name: 'scripted_visitor' },
      },
      { seed: 0, seasonId: season.id },
    )
    expect((await getSession(admin, sessionId))?.parameters).toEqual({
      seat_plan: 'cast_10',
      daynight: true,
    })

    await page.goto(`/sessions/${sessionId}`)
    const canvas = page.locator('canvas.renderer-canvas')
    const host = page.locator('.renderer-host')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    await expect(host).toHaveAttribute('data-three-branches-ground', 'ready')
    await expect(host).toHaveAttribute('data-three-branches-assets', 'ready')
    // The acted session takes a while to produce its first frame: every cast member (the submitted
    // neighbor agent) rebuilds the whole village graph during its reset, so the recording does not
    // stream its opening state until that setup finishes. The visitor probe only exists on a landed
    // frame, so wait for it rather than assuming a frame arrived with the assets.
    await expect
      .poll(async () => await host.getAttribute('data-three-branches-visitor'), { timeout: 240_000 })
      .toMatch(/^-?\d+,-?\d+$/)
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
    // Keep the ready submission and Village Life windows in the database. Only the temporary source
    // checkout and any still-running validation session belong to this test's local cleanup.
    if (sessionId !== null) {
      await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
    }
    rmSync(stagedDir, { recursive: true, force: true })
  }
})
