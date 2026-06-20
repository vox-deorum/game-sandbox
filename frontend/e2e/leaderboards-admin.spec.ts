import { type APIRequestContext, expect, test } from '@playwright/test'

const ENV_ID = 'flappy_bird'

interface Season {
  id: string
  label: string | null
}

async function declareSeason(
  request: APIRequestContext,
  label: string,
  options: { runnable?: boolean } = {},
): Promise<Season> {
  const declared = await request.post(`/api/admin/environments/${ENV_ID}/seasons`, {
    data: { label },
  })
  expect(declared.status(), await declared.text()).toBe(201)
  const season = (await declared.json()) as Season

  if (options.runnable) {
    const configured = await request.put(`/api/admin/seasons/${season.id}/config`, {
      data: {
        deps_version: 1,
        matches: [{ slots: ['builtin-naive'], seeds: [0], games: 1 }],
      },
    })
    expect(configured.status(), await configured.text()).toBe(200)
  }

  return season
}

async function releaseSeason(request: APIRequestContext, seasonId: string): Promise<void> {
  const released = await request.post(`/api/admin/seasons/${seasonId}/release`)
  expect(released.status(), await released.text()).toBe(200)
}

test('the Seasons index shows the refreshed released-season card and navigates to its boards', async ({
  page,
  request,
}) => {
  const label = `E2E season card ${Date.now()}`
  const season = await declareSeason(request, label)
  await releaseSeason(request, season.id)

  await page.goto('/seasons')

  const card = page.locator('li').filter({ hasText: label })
  await expect(card.getByRole('link', { name: 'Results released' })).toBeVisible()
  await expect(card.getByText(/0 Submissions · 0 Sessions Played/)).toBeVisible()
  await expect(card.locator('img.season-thumb')).toBeVisible()
  await expect(card.getByText('Open now')).toHaveCount(0)

  await card.getByRole('link', { name: `Open ${label}` }).click()
  await expect(page).toHaveURL(new RegExp(`/environments/${ENV_ID}/leaderboards/${season.id}$`))
})

test('released leaderboard history is visible and navigates by season URL', async ({
  page,
  request,
}) => {
  const suffix = `${Date.now()}`
  const older = await declareSeason(request, `E2E older ${suffix}`)
  await releaseSeason(request, older.id)
  const newer = await declareSeason(request, `E2E newer ${suffix}`)
  await releaseSeason(request, newer.id)

  await page.goto(`/environments/${ENV_ID}/leaderboards`)

  await expect(page.locator('.leaderboards-sub')).toContainText(`E2E newer ${suffix}`)
  await expect(page.getByText('Automated board')).toBeVisible()
  await expect(page.getByText('Human feedback')).toBeVisible()
  await expect(page.getByText('No automated results yet.')).toBeVisible()

  await page.getByRole('link', { name: `E2E older ${suffix}` }).click()
  await expect(page).toHaveURL(new RegExp(`/environments/${ENV_ID}/leaderboards/${older.id}$`))
  await expect(page.locator('.leaderboards-sub')).toContainText(`E2E older ${suffix}`)
})

test('the operator console tails a triggered workflow run', async ({ page, request }) => {
  test.setTimeout(180_000)
  const label = `E2E run ${Date.now()}`
  await declareSeason(request, label, { runnable: true })

  await page.goto(`/environments/${ENV_ID}/admin`)
  await page.getByRole('button', { name: new RegExp(label) }).click()
  await expect(page.getByRole('heading', { name: `Season ${label}` })).toBeVisible()

  await page.getByRole('button', { name: 'Run workflow' }).click()
  const logs = page.getByTestId('log-view')
  await expect(logs).toBeVisible({ timeout: 120_000 })
  await expect(logs).toContainText(/\S/)
  await expect(page.getByText('Run completed')).toBeVisible({ timeout: 120_000 })
})
