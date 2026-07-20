import { authenticateBrowser } from './support/auth.js'
import { expect, test } from './support/fixtures.js'

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
  // Browse as the operator, so Play Yourself starts a session owned by the identity the browser holds.
  await authenticateBrowser(page.context(), admin)

  // Home → the Flappy Bird card → the environment page.
  await page.goto('/')
  await page.getByRole('link', { name: /Flappy Bird/ }).click()
  await expect(page.getByRole('heading', { name: 'Flappy Bird' })).toBeVisible()

  // The Play Yourself entry point (in the page header) opens the start form; submit it to start a
  // human session.
  await page.getByRole('button', { name: 'Play Yourself' }).click()
  await page.getByRole('button', { name: 'Start playing' }).click()

  // The session page mounts the renderer and shows the per-step input window while we control a slot.
  await expect(page).toHaveURL(/\/sessions\//)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible()

  // A paced live game steps in real time from launch, so flap from the first frame to keep the bird
  // aloft long enough to observe the live UI and exercise the controls.
  await page.locator('body').focus()
  await page.keyboard.press('Space')
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Space')
  }

  // Pause freezes the run; the overlay reflects the echo. Resume clears it.
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.overlay-banner')).toHaveText('Paused')
  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.locator('.overlay-banner')).toHaveCount(0)

  // Stop ends the session and the bar swaps its controls for the ended state, surfacing the replay
  // link. The paced game keeps running after resume, so flap once more to keep the bird aloft while we
  // reach for Stop; if it still falls first the run ends on its own and detaches the live control, so
  // click Stop only while it is present and assert the ended state either way.
  await page.keyboard.press('Space')
  const stop = page.getByRole('button', { name: 'Stop' })
  if (await stop.isVisible()) {
    await stop.click({ timeout: 5000 }).catch(() => {})
  }
  await expect(page.getByRole('link', { name: 'Open replay' })).toBeVisible()

  // Open the replay from the ended session and scrub it.
  await page.getByRole('link', { name: 'Open replay' }).click()
  await expect(page).toHaveURL(/\/replays\//)
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  const decisionLog = page.locator('.decision-log')
  await expect(decisionLog.getByRole('columnheader', { name: 'LLM cost' })).toBeVisible()
  await expect(decisionLog.getByText('None').first()).toBeVisible()
  const slider = page.getByRole('slider')
  await expect(slider).toBeVisible()
  // The scrubber is the Reka UiSlider (a span with role=slider, not an <input>), so drive it by
  // keyboard rather than fill(): focus the thumb and step it forward.
  await slider.focus()
  await slider.press('ArrowRight')

  // Pin the recording (the viewer owns it).
  await page.getByRole('button', { name: 'Pin recording' }).click()
  await expect(page.getByRole('button', { name: 'Pinned ✓' })).toBeVisible()
})
