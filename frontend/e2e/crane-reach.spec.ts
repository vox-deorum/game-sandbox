import {
  configureMatches,
  declareSeason,
  release,
  setSeasonOverrides,
  startSession,
} from './support/api.js'
import { authenticateBrowser } from './support/auth.js'
import { expect, test } from './support/fixtures.js'

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
    live_interval_ms: 500,
    view_interval_ms: 750,
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

test('run and release a full-variant Crane Reach army season', async ({ page, admin }) => {
  test.setTimeout(900_000)
  await authenticateBrowser(page.context(), admin)

  const season = await declareSeason(admin, SEASON_LABEL, ENV_ID)
  await configureMatches(admin, season.id, [
    {
      seats: ['builtin:naive', 'builtin:naive'],
      seeds: [4],
      games: 1,
    },
  ])
  await setSeasonOverrides(admin, season.id, {
    parameters: {
      seat_plan: 'army',
      field_extent: 10,
      terrain: true,
      unit_abilities: true,
      capture_zones: 3,
      capture_target: 200,
      round_cap: 150,
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
    timeout: 720_000,
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
})
