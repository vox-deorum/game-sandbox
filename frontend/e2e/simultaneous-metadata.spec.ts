import type { Page } from '@playwright/test'

import { flappyMeta } from '../test/helpers/fixtures.js'
import { authenticateBrowser } from './support/auth.js'
import { expect, test } from './support/fixtures.js'

// flappyMeta's defaults (a paced, single-seat, sequential environment) already match a synthetic
// simultaneous solo environment except for the fields overridden below, so building on it here avoids
// hand-rolling the full metadata shape a second time.
const SOLO_META = flappyMeta({
  env_id: 'simultaneous_solo',
  display_name: 'Simultaneous solo',
  description: 'A synthetic simultaneous environment for start-form coverage.',
  recommended_episode_ticks: 20,
  stepping: 'simultaneous',
  parameters: [
    {
      name: 'players',
      title: 'Players',
      description: 'Number of players.',
      type: 'int',
      default: 1,
      min: 1,
      max: 1,
    },
  ],
})

const TEAM_META = {
  ...SOLO_META,
  env_id: 'simultaneous_team',
  display_name: 'Simultaneous team',
  layout: { kind: 'player_bounds', min: 2, max: 2 },
  human_players: ['player_0', 'player_1'],
  parameters: [
    {
      name: 'players',
      title: 'Players',
      description: 'Number of players.',
      type: 'int',
      default: 2,
      min: 2,
      max: 2,
    },
  ],
}

async function interceptSimultaneousCatalog(page: Page): Promise<void> {
  await page.route('**/api/environments', (route) =>
    route.fulfill({ json: [SOLO_META, TEAM_META] }),
  )
  await page.route('**/api/environments/*/play-parameters', (route) => {
    const envId = route.request().url().includes('simultaneous_team')
      ? TEAM_META.env_id
      : SOLO_META.env_id
    return route.fulfill({
      json: {
        season_id: 'synthetic-season',
        values: { players: envId === TEAM_META.env_id ? 2 : 1 },
      },
    })
  })
  await page.route('**/api/environments/*/leaderboards', (route) =>
    route.fulfill({
      json: {
        current: null,
        submission_season_id: 'synthetic-season',
        play_season_id: 'synthetic-season',
      },
    }),
  )
  await page.route('**/api/environments/*/seasons', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/environments/*/watch-agents', (route) => route.fulfill({ json: [] }))
}

test('synthetic simultaneous metadata offers an input window without a human-timeout override', async ({
  page,
  admin,
}) => {
  await authenticateBrowser(page.context(), admin)
  await interceptSimultaneousCatalog(page)

  await page.goto('/environments/simultaneous_solo')
  await page.getByRole('button', { name: 'Play' }).click()
  const soloDialog = page.getByRole('dialog')
  await expect(soloDialog.getByText('Input window (ms)')).toBeVisible()
  await expect(
    soloDialog.getByRole('spinbutton', { name: 'Per-step input window (ms)' }),
  ).toHaveCount(0)

  await page.goto('/environments/simultaneous_team')
  await page.getByRole('button', { name: 'Play' }).click()
  const teamDialog = page.getByRole('dialog')
  await expect(teamDialog.getByText('Input window (ms)')).toBeVisible()
  await expect(
    teamDialog.getByRole('spinbutton', { name: 'Per-step input window (ms)' }),
  ).toHaveCount(0)
})
