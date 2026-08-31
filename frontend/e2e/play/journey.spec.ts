import { readFile } from 'node:fs/promises'

import {
  activeWindows,
  getRecordingHeader,
  getSession,
  stopSessionAndAwaitFree,
} from '../support/api.js'
import { authenticateBrowser, userIdOf } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'

/**
 * The main journey, the executable form of the stage's experiential criteria: the browser signs in as
 * the operator (the seeded bootstrap admin), lands on home, opens Flappy Bird, plays a live session,
 * sees the canvas and the per-step input window, pauses and resumes, stops, and from the end card opens
 * the replay, scrubs it, and pins it.
 *
 * Pixel-level assertions stay out — the suite asserts the canvas is painted and the DOM facts around
 * it (controls, banners, the per-step window), not screenshots, so it does not flake on font or GPU
 * differences across runners. This suite needs a Docker daemon (it launches a real session).
 */
test('play Flappy Bird live, pause/resume, stop, then replay and pin', async ({ page, admin }) => {
  // Browse as the operator, so Play starts a session owned by the identity the browser holds.
  await authenticateBrowser(page.context(), admin)

  // Home → the Flappy Bird card → the environment page.
  await page.goto('/')
  await page.getByRole('link', { name: /Flappy Bird/ }).click()
  await expect(page.getByRole('heading', { name: 'Flappy Bird' })).toBeVisible()
  const playSection = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Open for Play: Playground' }),
  })
  const changes = playSection.getByRole('group', { name: 'Settings for play season Playground' })
  await expect(changes).toHaveClass(/info/)
  await expect(changes.getByText('Settings:', { exact: true })).toHaveCount(0)
  await expect(changes.getByText('Pipe gap', { exact: true })).toBeVisible()
  await expect(changes.getByText('100 → 90', { exact: true })).toBeVisible()
  await expect(changes.getByText('Decision limit', { exact: true })).toBeVisible()
  await expect(changes.getByText('1 s → 0.8 s', { exact: true })).toBeVisible()

  // The Play entry point in the play-season section opens the start form; submit it to start a
  // human session.
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.getByLabel('Pipe gap')).toHaveValue('90')
  await page.getByLabel('Pipe gap').fill('110')
  await page.getByRole('button', { name: 'Start playing' }).click()

  // The session page mounts the renderer and shows the per-step input window while we control a player.
  await expect(page).toHaveURL(/\/sessions\//)
  const sessionId = page.url().split('/').at(-1)
  if (sessionId === undefined) throw new Error('session URL has no id')

  await page.getByRole('button', { name: 'Start', exact: true }).click()

  // A paced live game steps in real time from launch, and a flap is latched per step. Keep the bird
  // aloft for the whole live section with a gentle flap cadence: a page-side interval dispatching the
  // same window keydown the renderer wires for a human player (see the renderer's input test), started
  // as soon as the session route is up so the bird is already held up whether or not the container has
  // begun stepping when we get here. Page-side dispatch skips per-key round-trips, and the harness
  // latches at most one flap per step, so a 400ms cadence cannot over-flap.
  await page.evaluate(() => {
    const patched = window as typeof window & { __flappyAutopilot?: number }
    if (patched.__flappyAutopilot !== undefined) {
      window.clearInterval(patched.__flappyAutopilot)
    }
    patched.__flappyAutopilot = window.setInterval(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', cancelable: true }))
    }, 400)
  })
  await page.locator('body').focus()
  await page.keyboard.press('Space')
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Space')
  }

  await expect
    .poll(async () => (await getSession(admin, sessionId))?.parameters)
    .toEqual({
      players: 1,
      pipe_gap: 110,
    })
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible()

  // Pause freezes the run; the overlay reflects the echo. Resume clears it.
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.overlay-banner')).toHaveText('Paused')
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.locator('.overlay-banner')).toHaveCount(0)

  // Stop ends the session and the bar swaps its controls for the ended state, surfacing the replay
  // link. The paced game keeps running after resume, so the autopilot aloft covers the reach for Stop;
  // if it still falls first the run ends on its own and detaches the live control, so click Stop only
  // while it is present and assert the ended state either way.
  const stop = page.getByRole('button', { name: 'Stop' })
  if (await stop.isVisible()) {
    await stop.click({ timeout: 5000 }).catch(() => {})
  }
  await expect(page.getByRole('link', { name: 'Open replay' })).toBeVisible()
  await page.evaluate(() => {
    const patched = window as typeof window & { __flappyAutopilot?: number }
    if (patched.__flappyAutopilot !== undefined) {
      window.clearInterval(patched.__flappyAutopilot)
      patched.__flappyAutopilot = undefined
    }
  })
  const endedSession = await getSession(admin, sessionId)
  if (endedSession?.recording_id === null || endedSession?.recording_id === undefined) {
    throw new Error('ended session has no recording')
  }
  const recordingId = endedSession.recording_id
  await expect
    .poll(async () => (await getRecordingHeader(admin, recordingId)).parameters)
    .toEqual({
      players: 1,
      pipe_gap: 110,
    })

  // Open the replay from the ended session and scrub it.
  await page.getByRole('link', { name: 'Open replay' }).click()
  await expect(page).toHaveURL(/\/replays\//)
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible()
  // The run's settings summarize in the status strip and open on hover: the pipe gap chosen above, and
  // the seed the run was played with.
  const settings = page.getByRole('button', { name: 'Show settings details' })
  await expect(settings).toHaveText('2 settings')
  await settings.hover()
  // The hover opens the settings bubble, but other tooltips on the page (e.g. the LLM cost details
  // trigger's) can be open at the same time, so pin this tooltip to the settings one by its content
  // rather than matching every tooltip on the page.
  const settingsTooltip = page.getByRole('tooltip', { name: /Pipe gap/ })
  await expect(settingsTooltip).toContainText('Pipe gap')
  await expect(settingsTooltip).toContainText('110')
  await expect(settingsTooltip).toContainText('Seed')
  const decisionLog = page.locator('.decision-log')
  await expect(decisionLog.getByRole('columnheader', { name: 'LLM cost' })).toHaveCount(0)
  await expect(decisionLog.getByText('None')).toHaveCount(0)
  const slider = page.getByRole('slider')
  await expect(slider).toBeVisible()
  // The scrubber is the Reka UiSlider (a span with role=slider, not an <input>), so drive it by
  // keyboard rather than fill(): focus the thumb and step it forward.
  await slider.focus()
  await slider.press('ArrowRight')

  // Pin the recording (the viewer owns it).
  await page.getByRole('button', { name: 'Pin recording' }).click()
  await expect(page.getByRole('button', { name: 'Pinned ✓' })).toBeVisible()

  // Fullscreen presents the stage alone; the floating bar keeps the transport operable.
  await page.getByRole('button', { name: 'Enter full screen' }).click()
  await expect(page.locator('.stage-canvas.is-fullscreen')).toBeVisible()
  await expect(page.locator('.replay-controls')).toBeHidden()
  const bar = page.locator('.fullscreen-controls')
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: 'Step forward' }).click()
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible()
  await page.keyboard.press('Escape')
  // Headless Chromium does not run the browser-chrome Escape handler that releases native fullscreen,
  // so release programmatically and confirm the stage and the controls row return.
  await page.evaluate(() => document.exitFullscreen())
  await expect(page.locator('.stage-canvas.is-fullscreen')).toHaveCount(0)
  await expect(page.locator('.replay-controls')).toBeVisible()
})

test('asks before replacing an active session, then starts the requested session', async ({
  page,
  admin,
}) => {
  await authenticateBrowser(page.context(), admin)
  let activeSessionId: string | null = null

  try {
    await page.goto('/environments/flappy_bird')
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.getByRole('button', { name: 'Start playing' }).click()
    await expect(page).toHaveURL(/\/sessions\//)
    const originalSessionId = page.url().split('/').at(-1)
    if (originalSessionId === undefined) throw new Error('first session URL has no id')
    activeSessionId = originalSessionId
    await page.getByRole('button', { name: 'Start', exact: true }).click()
    await page.getByRole('button', { name: 'Pause' }).click()
    await expect(page.locator('.overlay-banner')).toHaveText('Paused')

    // Leaving the session page does not end the owner's live session. A second request must ask
    // whether to replace it rather than silently sending the viewer back to it.
    await page.goto('/environments/flappy_bird')
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.getByRole('button', { name: 'Start playing' }).click()
    const conflict = page.getByRole('dialog', { name: 'A session is already running' })
    await expect(conflict).toBeVisible()
    await expect(conflict.getByRole('button', { name: 'Start new', exact: true })).toBeVisible()
    await expect(conflict.getByRole('button', { name: 'Return', exact: true })).toBeVisible()
    await conflict.getByRole('button', { name: 'Return', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/sessions/${originalSessionId}$`))

    await page.goto('/environments/flappy_bird')
    await page.getByRole('button', { name: 'Play', exact: true }).click()
    await page.getByRole('button', { name: 'Start playing' }).click()
    await page
      .getByRole('dialog', { name: 'A session is already running' })
      .getByRole('button', { name: 'Start new', exact: true })
      .click()
    await expect(page).toHaveURL(/\/sessions\//)
    const replacementSessionId = page.url().split('/').at(-1)
    if (replacementSessionId === undefined) throw new Error('replacement session URL has no id')
    expect(replacementSessionId).not.toBe(originalSessionId)
    activeSessionId = replacementSessionId

    await expect
      .poll(async () => (await getSession(admin, originalSessionId))?.status)
      .toBe('ended')
  } finally {
    if (activeSessionId !== null) {
      await stopSessionAndAwaitFree(admin, activeSessionId).catch(() => {})
    }
  }
})

test('shows submission-season changes and downloads its local setup file', async ({
  page,
  admin,
  as,
}) => {
  const windows = await activeWindows(admin)
  if (windows.submissionSeasonId === null) {
    throw new Error('the seeded submission season is missing')
  }

  const owner = await as('local-setup-owner')
  await authenticateBrowser(page.context(), owner)
  await page.goto(`/environments/flappy_bird/agents/${await userIdOf(owner)}`)

  const submissionSection = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Submit an Agent' }),
  })
  // The summary renders inside the submit form, above its fields.
  const changes = submissionSection.locator('form').getByRole('group', {
    name: 'Settings for submission season Playground',
  })
  await expect(changes).toHaveClass(/info/)
  await expect(changes.getByText('Settings:', { exact: true })).toHaveCount(0)
  await expect(changes.getByText('Pipe gap', { exact: true })).toBeVisible()
  await expect(changes.getByText('100 → 90', { exact: true })).toBeVisible()
  await expect(changes.getByText('Decision limit', { exact: true })).toBeVisible()
  await expect(changes.getByText('1 s → 0.8 s', { exact: true })).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Set Up Locally' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('season.json')
  const downloadPath = await download.path()
  if (downloadPath === null) throw new Error('season settings download has no local path')
  expect(JSON.parse(await readFile(downloadPath, 'utf8'))).toEqual({
    env_id: 'flappy_bird',
    season: 'Playground',
    parameters: { pipe_gap: 90 },
    decision_limit_ms: 750,
  })

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('git clone -b templates/flappy_bird --single-branch')
  await expect(dialog).toContainText('git remote remove origin')
  await expect(dialog.getByRole('button', { name: 'Copy setup commands' })).toBeVisible()
  await expect(dialog).toContainText(
    'Move the downloaded season.json next to manifest.json in the cloned folder.',
  )
  await expect(dialog.getByText('manifest.json', { exact: true })).toBeVisible()
})
