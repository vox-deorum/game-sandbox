import { activeWindows, setSeasonOverrides } from './support/api.js'
import { expect, test } from './support/fixtures.js'

/**
 * Give the retained Flappy Bird Playground season locally reproducible changes before any journey
 * creates activity. The completed E2E database powers `npm run demo`, so keeping this seeded season
 * open lets a member exercise the complete Set Up Locally flow against realistic fixture data.
 */
test('the retained Playground season has local settings', async ({ admin }) => {
  const windows = await activeWindows(admin)
  expect(windows.submissionSeasonId).not.toBeNull()
  expect(windows.playSeasonId).toBe(windows.submissionSeasonId)

  await setSeasonOverrides(admin, windows.submissionSeasonId as string, {
    step_timeout_ms: 750,
    parameters: { pipe_gap: 90 },
  })
})
