import {
  configureMatches,
  declareSeason,
  release,
  setSeasonOverrides,
  startSession,
  stopSessionAndAwaitFree,
} from '../support/api.js'
import { authenticateBrowser } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'

const ENV_ID = 'skirmish_crane'
const SEASON_LABEL = 'Crane Reach Army'

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

  await page.goto(`/environments/${ENV_ID}`)
  const naive = page.locator('.agent-row--builtin', { hasText: 'Naive' })
  await naive.getByRole('button', { name: 'Watch' }).click()
  const dialog = page.getByRole('dialog', { name: /Watch Skirmish at Crane Reach/ })
  const preset = dialog.getByRole('combobox', { name: 'Preset' })
  await preset.selectOption('season_1')
  await expect(preset).toHaveValue('season_1')
  await dialog.getByRole('spinbutton', { name: 'Seed (optional)' }).fill('7')
  await dialog.getByRole('button', { name: 'Start watching' }).click()
  await expect(page).toHaveURL(/\/sessions\//)
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
  await expect(rendererHost).toHaveAttribute('data-crane-camera', '1.24@600,418')

  await page.setViewportSize({ width: 390, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'compact')
  await page.setViewportSize({ width: 500, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await page.setViewportSize({ width: 640, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await page.setViewportSize({ width: 1_100, height: 1_000 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await page.setViewportSize({ width: 1_600, height: 1_000 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'token')
  await expect(rendererHost).toHaveAttribute('data-crane-battlefield-builds', '1')

  await page.setViewportSize({ width: 390, height: 900 })
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'compact')
  const canvas = page.locator('canvas.renderer-canvas')
  let canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()
  if (canvasBox === null) throw new Error('Crane Reach canvas has no browser bounds')
  const canvasCenter = {
    x: canvasBox.x + canvasBox.width / 2,
    y: canvasBox.y + canvasBox.height / 2,
  }
  const parseCamera = (value: string | null) => {
    const match = /^(\d+(?:\.\d+)?)@(-?\d+),(-?\d+)$/.exec(value ?? '')
    if (match === null) throw new Error(`Unexpected Crane Reach camera probe: ${value}`)
    return { zoom: Number(match[1]), x: Number(match[2]), y: Number(match[3]) }
  }
  const viewPoint = (
    bounds: { x: number; y: number; width: number; height: number },
    x: number,
    y: number,
  ) => ({
    x: bounds.x + (x / 1_200) * bounds.width,
    y: bounds.y + (y / 860) * bounds.height,
  })
  const fittedCamera = parseCamera(await rendererHost.getAttribute('data-crane-camera'))
  const zoomAnchorX = Number(await rendererHost.getAttribute('data-crane-inspect-unit-x'))
  const zoomAnchorY = Number(await rendererHost.getAttribute('data-crane-inspect-unit-y'))
  expect(Number.isFinite(zoomAnchorX)).toBe(true)
  expect(Number.isFinite(zoomAnchorY)).toBe(true)
  const zoomAnchor = viewPoint(canvasBox, zoomAnchorX, zoomAnchorY)

  await page.mouse.move(zoomAnchor.x, zoomAnchor.y)
  await page.mouse.wheel(0, -700)
  await expect(rendererHost).toHaveAttribute('data-crane-presentation', 'figure')
  await expect
    .poll(async () => parseCamera(await rendererHost.getAttribute('data-crane-camera')).zoom)
    .toBeGreaterThan(fittedCamera.zoom)

  const zoomedCamera = parseCamera(await rendererHost.getAttribute('data-crane-camera'))
  await page.mouse.move(canvasCenter.x, canvasCenter.y)
  await page.mouse.down()
  await page.mouse.move(canvasCenter.x + 80, canvasCenter.y)
  await page.mouse.up()
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'none')
  await expect
    .poll(async () => parseCamera(await rendererHost.getAttribute('data-crane-camera')).x)
    .not.toBe(zoomedCamera.x)

  const unitId = await rendererHost.getAttribute('data-crane-inspect-unit')
  const unitX = Number(await rendererHost.getAttribute('data-crane-inspect-unit-x'))
  const unitY = Number(await rendererHost.getAttribute('data-crane-inspect-unit-y'))
  expect(unitId).not.toBeNull()
  expect(Number.isFinite(unitX)).toBe(true)
  expect(Number.isFinite(unitY)).toBe(true)
  // The inspection probe is in the camera's logical view space, then mapped to canvas CSS pixels.
  const unitPoint = viewPoint(canvasBox, unitX, unitY)
  await page.mouse.move(unitPoint.x, unitPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', `unit:${unitId}`)
  await expect(rendererHost).toHaveAttribute(
    'data-crane-inspection-fields',
    'iconHp:HP,iconMove:MOV,iconAttack:ATK,iconRange:RNG,iconVision:VIS',
  )
  await expect(rendererHost).not.toHaveAttribute('data-crane-inspection-details')
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    if (host === null) throw new Error('Crane Reach renderer host is missing')
    const probe = globalThis as typeof globalThis & {
      craneInspectionObserver?: MutationObserver
      craneInspectionSamples?: string[]
    }
    probe.craneInspectionObserver?.disconnect()
    probe.craneInspectionSamples = [host.dataset.craneInspection ?? 'missing']
    probe.craneInspectionObserver = new MutationObserver((records) => {
      for (const record of records) {
        probe.craneInspectionSamples?.push(record.oldValue ?? 'missing')
      }
      probe.craneInspectionSamples?.push(host.dataset.craneInspection ?? 'missing')
    })
    probe.craneInspectionObserver.observe(host, {
      attributes: true,
      attributeFilter: ['data-crane-inspection'],
      attributeOldValue: true,
    })
  })
  for (const [dx, dy] of [
    [-4, -4],
    [4, -2],
    [-3, 3],
    [4, 4],
    [0, 0],
  ]) {
    await page.mouse.move(unitPoint.x + dx, unitPoint.y + dy)
  }
  const inspectionSamples = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const probe = globalThis as typeof globalThis & {
      craneInspectionObserver?: MutationObserver
      craneInspectionSamples?: string[]
    }
    probe.craneInspectionObserver?.disconnect()
    return probe.craneInspectionSamples ?? []
  })
  expect([...new Set(inspectionSamples)]).toEqual([`unit:${unitId}`])

  await page.mouse.dblclick(canvasCenter.x, canvasCenter.y)
  await expect(rendererHost).toHaveAttribute('data-crane-camera', '1.24@600,418')

  await page.setViewportSize({ width: 1_600, height: 1_000 })
  await expect.poll(async () => (await canvas.boundingBox())?.width ?? 0).toBeGreaterThan(600)
  canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()
  if (canvasBox === null) throw new Error('Crane Reach canvas has no browser bounds after reset')
  const awayPoint = viewPoint(canvasBox, 600, 40)
  await page.mouse.move(awayPoint.x, awayPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'none')
  const rosterPoint = viewPoint(canvasBox, 42, 804)
  await page.mouse.move(rosterPoint.x, rosterPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'roster:red:footman')
  await page.mouse.move(awayPoint.x, awayPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', 'none')

  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    if (host === null) throw new Error('Crane Reach renderer host is missing')
    const probe = globalThis as typeof globalThis & {
      craneEventObserver?: MutationObserver
      craneEventSamples?: Array<{ phase: string; tracks: string }>
    }
    const read = (): { phase: string; tracks: string } => ({
      phase: host.dataset.craneEventPhase ?? 'idle',
      tracks: host.dataset.craneEventTracks ?? '',
    })
    probe.craneEventObserver?.disconnect()
    probe.craneEventSamples = [read()]
    probe.craneEventObserver = new MutationObserver(() => {
      const sample = read()
      const previous = probe.craneEventSamples?.at(-1)
      if (previous?.phase === sample.phase && previous.tracks === sample.tracks) return
      probe.craneEventSamples?.push(sample)
    })
    probe.craneEventObserver.observe(host, {
      attributes: true,
      attributeFilter: ['data-crane-event-phase', 'data-crane-event-tracks'],
    })
  })
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(rendererHost).toHaveAttribute('data-crane-event-phase', 'movement', {
    timeout: 30_000,
  })
  const eventHoverUnitId = await rendererHost.getAttribute('data-crane-inspect-unit')
  const eventActorId = await rendererHost.getAttribute('data-crane-event-actor')
  const eventHoverUnitX = Number(await rendererHost.getAttribute('data-crane-inspect-unit-x'))
  const eventHoverUnitY = Number(await rendererHost.getAttribute('data-crane-inspect-unit-y'))
  expect(eventHoverUnitId).not.toBeNull()
  if (eventHoverUnitId === null) throw new Error('Crane Reach event hover unit is missing')
  expect(eventHoverUnitId).not.toBe(eventActorId)
  expect(Number.isFinite(eventHoverUnitX)).toBe(true)
  expect(Number.isFinite(eventHoverUnitY)).toBe(true)
  const eventHoverPoint = viewPoint(canvasBox, eventHoverUnitX, eventHoverUnitY)
  await page.mouse.move(eventHoverPoint.x, eventHoverPoint.y)
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', `unit:${eventHoverUnitId}`)
  await expect(rendererHost).toHaveAttribute('data-crane-range-unit', eventHoverUnitId)
  await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.renderer-host')
    if (host === null) throw new Error('Crane Reach renderer host is missing')
    const probe = globalThis as typeof globalThis & {
      craneRangeObserver?: MutationObserver
      craneRangeSamples?: string[]
    }
    probe.craneRangeObserver?.disconnect()
    probe.craneRangeSamples = [host.dataset.craneRangeUnit ?? 'missing']
    probe.craneRangeObserver = new MutationObserver((records) => {
      for (const record of records) probe.craneRangeSamples?.push(record.oldValue ?? 'missing')
      probe.craneRangeSamples?.push(host.dataset.craneRangeUnit ?? 'missing')
    })
    probe.craneRangeObserver.observe(host, {
      attributes: true,
      attributeFilter: ['data-crane-range-unit'],
      attributeOldValue: true,
    })
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
    /^(activation|movement|attack|reaction)$/,
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
  expect(resizeResult.samples.at(-1)?.phase).toMatch(/^(activation|movement|attack|reaction)$/)
  // The event schedule, observed live. Wait until enough events have played that the sample stream
  // covers a reacting attack, then assert the schedule's three visible properties at once.
  const readEventSamples = (): Promise<Array<{ phase: string; tracks: string }>> =>
    page.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            craneEventSamples?: Array<{ phase: string; tracks: string }>
          }
        ).craneEventSamples ?? [],
    )
  await expect
    .poll(
      async () =>
        (await readEventSamples()).filter(
          (sample) => sample.tracks.includes('attack') && sample.tracks.includes('reaction'),
        ).length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  const eventSamples = await readEventSamples()

  // Beats run in schedule order within an event, and an event always returns to idle before the next
  // one installs, so a superseding state never leaves a held intermediary frame on screen.
  const BEATS = ['activation', 'movement', 'attack', 'reaction']
  let events = 0
  let previousBeat = -1
  for (const sample of eventSamples) {
    if (sample.phase === 'idle') {
      previousBeat = -1
      continue
    }
    const beat = BEATS.indexOf(sample.phase)
    expect(beat, `unexpected phase ${sample.phase}`).toBeGreaterThanOrEqual(0)
    expect(beat, `beat ${sample.phase} ran after a later one`).toBeGreaterThanOrEqual(previousBeat)
    if (previousBeat === -1) events += 1
    previousBeat = beat
  }
  expect(events).toBeGreaterThan(1)
  // Every event opens on its activation, including one that neither moves nor strikes.
  expect(eventSamples.filter((sample) => sample.phase === 'activation').length).toBe(events)
  const eventRangeSamples = await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const probe = globalThis as typeof globalThis & {
      craneRangeObserver?: MutationObserver
      craneRangeSamples?: string[]
    }
    probe.craneRangeObserver?.disconnect()
    return probe.craneRangeSamples ?? []
  })
  expect([...new Set(eventRangeSamples)]).toEqual([eventHoverUnitId])
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
  // about the pipeline depends on it. round_cap sits at 100 because that is the floor the environment
  // declares (see ROUND_CAP_BOUNDS); a season override below it is refused. The renderer's own
  // coverage of a long army battle is offline, over
  // frontend/test/fixtures/crane-reach-army-recording.jsonl.
  await setSeasonOverrides(admin, season.id, {
    parameters: {
      seat_plan: 'army',
      field_extent: 10,
      terrain: true,
      unit_abilities: true,
      capture_zones: 3,
      capture_target: 60,
      round_cap: 100,
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

  const canvas = page.locator('canvas.renderer-canvas')
  const canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()
  if (canvasBox === null) throw new Error('Crane Reach army canvas has no browser bounds')
  const unitId = await rendererHost.getAttribute('data-crane-inspect-unit')
  const unitX = Number(await rendererHost.getAttribute('data-crane-inspect-unit-x'))
  const unitY = Number(await rendererHost.getAttribute('data-crane-inspect-unit-y'))
  expect(unitId).not.toBeNull()
  await page.mouse.move(
    canvasBox.x + (unitX / 1_200) * canvasBox.width,
    canvasBox.y + (unitY / 860) * canvasBox.height,
  )
  await expect(rendererHost).toHaveAttribute('data-crane-inspection', `unit:${unitId}`)
  await expect(rendererHost).toHaveAttribute(
    'data-crane-inspection-details',
    /^iconTerrain:(grass|hill),iconFeature:(none|forest|marsh),iconSkill:shield_wall$/,
  )
})

/**
 * The bounded human segment. Everything about composing an order is proved in the jsdom suite and the
 * mask-agreement suite; what only a browser can show is that real clicks on painted controls and hexes
 * reach the environment. So this walks one step, resets it, sends another, and then sends the empty
 * stay path. Canvas clicks are the most brittle thing in this suite, so it stays narrowly focused.
 */
test('compose and send a Crane Reach order by clicking the board', async ({ page, admin }) => {
  test.setTimeout(180_000)

  // Skirmish gives each side one wide seat of three units, and every Crane Reach player is
  // human-capable, so `self` puts the whole red side under one person. A generous move clock keeps
  // the turn open while Playwright works, since the harness would otherwise stand the unit still.
  const sessionId = await startSession(
    admin,
    ENV_ID,
    {
      seat_0: { kind: 'human', companion: { kind: 'self' } },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
    },
    // No parameter override: the play-open season's complete map already resolves to the default
    // skirmish plan, and a partial map is rejected outright.
    { seed: 4, humanTimeoutMs: 120_000 },
  )

  try {
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/sessions/${sessionId}`)

    const canvas = page.locator('canvas.renderer-canvas')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    const rendererHost = page.locator('.renderer-host')
    await expect(rendererHost).toHaveAttribute('data-crane-hud', 'ready')

    const box = await canvas.boundingBox()
    if (box === null) throw new Error('the Crane Reach canvas has no browser bounds')
    // `position` is relative to the canvas, and the renderer's own space is 1200 by 860.
    const at = (x: number, y: number) => ({ x: (x / 1_200) * box.width, y: (y / 860) * box.height })

    // The controls open only on a controlled activation, so this is also the wait for our own turn.
    await expect(rendererHost).toHaveAttribute('data-crane-confirm', 'ready', { timeout: 60_000 })
    // Fog is on for a player, so the rosters are gone and the board is drawn through one unit's eyes.
    await expect(rendererHost).toHaveAttribute('data-crane-rosters', 'hidden')
    await expect(rendererHost).not.toHaveAttribute('data-crane-fog', 'none')
    await expect(rendererHost).toHaveAttribute('data-crane-order', '')
    await expect(rendererHost).toHaveAttribute('data-crane-reset', 'inactive')
    await expect(rendererHost).toHaveAttribute('data-crane-step-text-resolution', 'none')

    // One step onto an offered hex. Its probe is already projected into the drawing space.
    const offeredX = await rendererHost.getAttribute('data-crane-offered-x')
    const offeredY = await rendererHost.getAttribute('data-crane-offered-y')
    if (offeredX === null || offeredY === null)
      throw new Error('no Crane Reach continuation offered')
    await canvas.click({ position: at(Number(offeredX), Number(offeredY)) })
    await expect(rendererHost).toHaveAttribute('data-crane-order', /^[1-6]$/)
    await expect(rendererHost).toHaveAttribute('data-crane-order-path', /^[1-6]$/)
    await expect(rendererHost).toHaveAttribute('data-crane-reset', 'ready')
    const stepResolution = Number(
      await rendererHost.getAttribute('data-crane-step-text-resolution'),
    )
    expect(Number.isFinite(stepResolution)).toBe(true)

    // Zoom forces the numeral texture to rebake at the higher camera-aware resolution.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -700)
    await expect
      .poll(async () => Number(await rendererHost.getAttribute('data-crane-step-text-resolution')))
      .toBeGreaterThan(stepResolution)

    // Return to the fitted view before choosing another board hex. At maximum zoom, a legal
    // continuation can be outside the clipped canvas even though its projected probe is valid.
    await page.mouse.wheel(0, 700)
    await expect
      .poll(async () => Number(await rendererHost.getAttribute('data-crane-step-text-resolution')))
      .toBeLessThanOrEqual(stepResolution)

    const resetX = await rendererHost.getAttribute('data-crane-reset-x')
    const resetY = await rendererHost.getAttribute('data-crane-reset-y')
    if (resetX === null || resetY === null) throw new Error('Crane Reach reset control is missing')
    await canvas.click({ position: at(Number(resetX), Number(resetY)) })
    await expect(rendererHost).toHaveAttribute('data-crane-order', '')
    await expect(rendererHost).toHaveAttribute('data-crane-order-path', '0')
    await expect(rendererHost).toHaveAttribute('data-crane-confirm', 'ready')
    await expect(rendererHost).toHaveAttribute('data-crane-reset', 'inactive')
    await expect(rendererHost).toHaveAttribute('data-crane-step-text-resolution', 'none')

    // Camera reconciliation moves the offered probe, so reread it before composing again.
    const resetOfferedX = await rendererHost.getAttribute('data-crane-offered-x')
    const resetOfferedY = await rendererHost.getAttribute('data-crane-offered-y')
    if (resetOfferedX === null || resetOfferedY === null)
      throw new Error('no Crane Reach continuation offered after reset')
    await canvas.click({ position: at(Number(resetOfferedX), Number(resetOfferedY)) })
    await expect(rendererHost).toHaveAttribute('data-crane-order', /^[1-6]$/)

    // Confirm stays on the right side of the fixed bottom-strip control pair.
    await canvas.click({ position: at(636, 802) })
    await expect(rendererHost).toHaveAttribute('data-crane-confirm', 'none')

    // The order reached the environment and came back as a resolved activation for our own unit.
    await expect(rendererHost).toHaveAttribute('data-crane-event-actor', /^red_/, {
      timeout: 60_000,
    })

    // Our next turn sends the empty path, which is the always-legal stand still and strike.
    await expect(rendererHost).toHaveAttribute('data-crane-confirm', 'ready', { timeout: 90_000 })
    await expect(rendererHost).toHaveAttribute('data-crane-order', '')
    await expect(rendererHost).toHaveAttribute('data-crane-order-path', '0')
    await canvas.click({ position: at(636, 802) })
    await expect(rendererHost).toHaveAttribute('data-crane-confirm', 'none')
    await expect(rendererHost).toHaveAttribute('data-crane-event-actor', /^red_/, {
      timeout: 60_000,
    })
  } finally {
    await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
  }
})
