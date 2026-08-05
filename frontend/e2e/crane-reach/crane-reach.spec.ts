import {
  configureMatches,
  declareSeason,
  release,
  setSeasonOverrides,
  startSession,
} from '../support/api.js'
import { authenticateBrowser } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'

const ENV_ID = 'skirmish_crane'
const SEASON_LABEL = 'Crane Reach Army'

const ALL_NAIVE_SEATS = {
  seat_0: { kind: 'builtin-agent' as const, name: 'naive' },
  seat_1: { kind: 'builtin-agent' as const, name: 'naive' },
}

test('watch a Crane Reach skirmish to game over and seek its exact replay frames', async ({
  page,
  admin,
}) => {
  test.setTimeout(300_000)
  await authenticateBrowser(page.context(), admin)

  const environmentsResponse = await admin.get('/api/environments')
  expect(environmentsResponse.ok()).toBe(true)
  const environments = (await environmentsResponse.json()) as Array<{
    env_id: string
    live_interval_ms: number | null
    view_interval_ms: number | null
  }>
  expect(environments.find((environment) => environment.env_id === ENV_ID)).toMatchObject({
    live_interval_ms: 1_000,
    view_interval_ms: 1_000,
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Skirmish at Crane Reach' })).toBeVisible()

  const sessionId = await startSession(admin, ENV_ID, ALL_NAIVE_SEATS, { seed: 7 })
  await page.goto(`/sessions/${sessionId}`)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

  const replayLink = page.getByRole('link', { name: 'Open replay' })
  await expect(replayLink).toBeVisible({ timeout: 210_000 })
  await replayLink.click()
  await expect(page).toHaveURL(/\/replays\//)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

  const rendererHost = page.locator('.renderer-host')
  await expect(rendererHost).toHaveAttribute('data-crane-assets', 'ready')
  await expect(rendererHost).toHaveAttribute('data-crane-battlefield-builds', '1')
  await expect(rendererHost).toHaveAttribute('data-crane-hud', 'ready')

  await page.setViewportSize({ width: 390, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'compact')
  await page.setViewportSize({ width: 640, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await page.setViewportSize({ width: 1_100, height: 1_000 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'figure')
  await page.setViewportSize({ width: 1_600, height: 1_000 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await expect(rendererHost).toHaveAttribute('data-crane-battlefield-builds', '1')

  const canvas = page.locator('canvas.renderer-canvas')
  const canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()
  if (canvasBox === null) throw new Error('Crane Reach canvas has no browser bounds')
  const unitId = await rendererHost.getAttribute('data-crane-inspect-unit')
  const unitX = Number(await rendererHost.getAttribute('data-crane-inspect-unit-x'))
  const unitY = Number(await rendererHost.getAttribute('data-crane-inspect-unit-y'))
  expect(unitId).not.toBeNull()
  expect(Number.isFinite(unitX)).toBe(true)
  expect(Number.isFinite(unitY)).toBe(true)
  const logicalPoint = (x: number, y: number) => ({
    x: canvasBox.x + (x / 1_200) * canvasBox.width,
    y: canvasBox.y + (y / 860) * canvasBox.height,
  })
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'none')
  const unitPoint = logicalPoint(unitX, unitY)
  await page.mouse.move(unitPoint.x, unitPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', `unit:${unitId}`)
  await expect(rendererHost).toHaveAttribute(
    'data-crane-inspection-fields',
    'iconHp:HP,iconMove:MOV,iconAttack:ATK,iconRange:RNG,iconVision:VIS',
  )
  const awayPoint = logicalPoint(600, 40)
  await page.mouse.move(awayPoint.x, awayPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'none')
  const rosterPoint = logicalPoint(42, 804)
  await page.mouse.move(rosterPoint.x, rosterPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'roster:red:footman')
  await page.mouse.move(awayPoint.x, awayPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'none')

  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    if (host === null) throw new Error('Crane Reach renderer host is missing')
    const probe = globalThis as typeof globalThis & {
      craneEventObserver?: MutationObserver
      craneEventSamples?: Array<{ phase: string; handoff: string }>
    }
    probe.craneEventObserver?.disconnect()
    probe.craneEventSamples = [
      {
        phase: host.dataset.craneEventPhase ?? 'idle',
        handoff: host.dataset.craneEventHandoff ?? 'idle',
      },
    ]
    probe.craneEventObserver = new MutationObserver(() => {
      const sample = {
        phase: host.dataset.craneEventPhase ?? 'idle',
        handoff: host.dataset.craneEventHandoff ?? 'idle',
      }
      const previous = probe.craneEventSamples?.at(-1)
      if (previous?.phase === sample.phase && previous.handoff === sample.handoff) return
      probe.craneEventSamples?.push(sample)
    })
    probe.craneEventObserver.observe(host, {
      attributes: true,
      attributeFilter: ['data-crane-event-phase', 'data-crane-event-handoff'],
    })
  })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(rendererHost).toHaveAttribute('data-crane-event-phase', 'movement', {
    timeout: 30_000,
  })
  const beforeResize = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.renderer-canvas')
    if (host === null || canvas === null) throw new Error('Crane Reach renderer surface is missing')
    const hostBox = host.getBoundingClientRect()
    const canvasBox = canvas.getBoundingClientRect()
    return {
      host: { width: hostBox.width, height: hostBox.height },
      canvas: { width: canvasBox.width, height: canvasBox.height, pixels: canvas.width },
    }
  })
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    if (host === null) throw new Error('Crane Reach renderer host is missing')
    const probe = globalThis as typeof globalThis & {
      craneResizeAnimationFrame?: number
      craneResizeStartedAt?: number
      craneResizeSamples?: Array<{ phase: string; at: number }>
    }
    if (probe.craneResizeAnimationFrame !== undefined) {
      cancelAnimationFrame(probe.craneResizeAnimationFrame)
    }
    probe.craneResizeStartedAt = performance.now()
    probe.craneResizeSamples = []
    const record = () => {
      probe.craneResizeSamples?.push({
        phase: host.dataset.craneEventPhase ?? 'idle',
        at: performance.now(),
      })
      probe.craneResizeAnimationFrame = requestAnimationFrame(record)
    }
    record()
  })
  // Changing height changes StageFrame's 70vh cap, forcing both the host and Pixi surface to resize.
  await page.setViewportSize({ width: 1_600, height: 700 })
  await page.waitForTimeout(150)
  await expect(rendererHost).toHaveAttribute(
    'data-crane-event-phase',
    /^(activation|movement|settle|resolution)$/,
  )
  const resizeResult = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.renderer-canvas')
    if (host === null || canvas === null) throw new Error('Crane Reach renderer surface is missing')
    const hostBox = host.getBoundingClientRect()
    const canvasBox = canvas.getBoundingClientRect()
    const probe = globalThis as typeof globalThis & {
      craneResizeAnimationFrame?: number
      craneResizeStartedAt?: number
      craneResizeSamples?: Array<{ phase: string; at: number }>
    }
    if (probe.craneResizeAnimationFrame !== undefined) {
      cancelAnimationFrame(probe.craneResizeAnimationFrame)
      delete probe.craneResizeAnimationFrame
    }
    return {
      elapsed: performance.now() - (probe.craneResizeStartedAt ?? performance.now()),
      samples: probe.craneResizeSamples ?? [],
      host: { width: hostBox.width, height: hostBox.height },
      canvas: { width: canvasBox.width, height: canvasBox.height, pixels: canvas.width },
    }
  })
  expect(resizeResult.elapsed).toBeLessThan(1_000)
  expect(resizeResult.host.height).toBeLessThan(beforeResize.host.height)
  expect(resizeResult.canvas.height).toBeLessThan(beforeResize.canvas.height)
  expect(resizeResult.canvas.pixels).not.toBe(beforeResize.canvas.pixels)
  expect(resizeResult.samples).not.toHaveLength(0)
  expect(resizeResult.samples.some((sample) => sample.phase === 'idle')).toBe(false)
  expect(resizeResult.samples.at(-1)?.phase).toMatch(/^(activation|movement|settle|resolution)$/)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const samples =
            (
              globalThis as typeof globalThis & {
                craneEventSamples?: Array<{ phase: string; handoff: string }>
              }
            ).craneEventSamples ?? []
          let awaitingSeen = false
          let heldSeen = false
          for (const sample of samples) {
            if (sample.phase === 'idle' && sample.handoff === 'awaiting-final-frame') {
              awaitingSeen = true
            } else if (
              awaitingSeen &&
              sample.phase === 'idle' &&
              sample.handoff === 'final-frame-held'
            ) {
              heldSeen = true
            } else if (
              heldSeen &&
              sample.phase === 'activation' &&
              sample.handoff === 'pending-installed'
            ) {
              return true
            }
          }
          return false
        }),
      { timeout: 30_000 },
    )
    .toBe(true)
  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  const replayStage = page.getByRole('group', { name: 'Replay stage' })
  await replayStage.click()
  await replayStage.press('Home')
  await expect(rendererHost).toHaveAttribute('data-crane-event-phase', 'idle')

  const position = page.locator('.replay-position')
  await expect(position).toContainText('1/')
  await page.getByRole('button', { name: 'Step forward' }).click()
  await expect(position).toContainText('2/')

  const slider = page.getByRole('slider')
  await expect(slider).toBeVisible()
  const lastFrame = await slider.getAttribute('aria-valuemax')
  expect(lastFrame).not.toBeNull()

  const stage = page.getByRole('group', { name: 'Replay stage' })
  await stage.click()
  await stage.press('End')
  await expect(slider).toHaveAttribute('aria-valuenow', lastFrame as string)
  await expect(page.getByRole('dialog', { name: 'Game over' }).locator('.row')).toHaveCount(2)

  // While the game-over card is up the stage ignores transport keys, so dismiss it before seeking.
  await stage.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Game over' })).toHaveCount(0)

  await stage.press('Home')
  await expect(slider).toHaveAttribute('aria-valuenow', '0')
  await expect(position).toContainText('1/')
})

test('run and release a full-variant Crane Reach army season', { tag: '@slow' }, async ({
  page,
  admin,
}) => {
  test.setTimeout(400_000)
  await authenticateBrowser(page.context(), admin)

  const season = await declareSeason(admin, SEASON_LABEL, ENV_ID)
  await configureMatches(admin, season.id, [
    {
      seats: ['builtin:naive', 'builtin:naive'],
      seeds: [4],
      games: 1,
    },
  ])
  // Every full-variant flag stays on: this test exists to prove the army seat plan, terrain, unit
  // abilities, and capture zones survive a real run and release. Only the two knobs that decide how
  // long the battle lasts are turned down, since the length is what costs the wall clock and nothing
  // about the pipeline depends on it. The renderer's own coverage of a long army battle is offline,
  // over frontend/test/fixtures/crane-reach-army-recording.jsonl.
  await setSeasonOverrides(admin, season.id, {
    parameters: {
      seat_plan: 'army',
      field_extent: 10,
      terrain: true,
      unit_abilities: true,
      capture_zones: 3,
      capture_target: 60,
      round_cap: 40,
    },
  })

  await page.goto(`/environments/${ENV_ID}/admin`)
  await page.getByRole('button', { name: new RegExp(SEASON_LABEL) }).click()
  await expect(page.getByRole('heading', { name: `Season ${SEASON_LABEL}` })).toBeVisible()
  await expect(page.getByText('Projected total: 1 game', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Run workflow' }).click()
  await expect(page).toHaveURL(
    new RegExp(`/environments/${ENV_ID}/admin/seasons/${season.id}/runs/`),
  )
  await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.run-header .ui-status-badge')).toHaveText('completed', {
    timeout: 240_000,
  })

  await release(admin, season.id)
  await page.goto(`/environments/${ENV_ID}/leaderboards/${season.id}`)
  const scoreboard = page.locator('section.board', { hasText: 'Scoreboard' })
  await expect(scoreboard.getByText('naive')).toBeVisible()

  const matchups = page.getByRole('region', { name: 'Matchups' })
  const game = matchups.getByTestId('game-row').first()
  await expect(game).toBeVisible()
  await game.getByRole('link', { name: 'Replay' }).click()
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
  const rendererHost = page.locator('.renderer-host')
  await expect(rendererHost).toHaveAttribute('data-crane-assets', 'ready')
  await expect(rendererHost).toHaveAttribute('data-crane-battlefield-builds', '1')
  await expect(rendererHost).toHaveAttribute('data-crane-hud', 'ready')
})
