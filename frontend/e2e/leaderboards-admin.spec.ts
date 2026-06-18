import { type APIRequestContext, expect, test } from '@playwright/test'

const ENV_ID = 'flappy_bird'

interface Iteration {
  id: string
  label: string | null
}

async function declareIteration(
  request: APIRequestContext,
  label: string,
  options: { runnable?: boolean } = {},
): Promise<Iteration> {
  const declared = await request.post(`/api/admin/environments/${ENV_ID}/iterations`, {
    data: { label },
  })
  expect(declared.status(), await declared.text()).toBe(201)
  const iteration = (await declared.json()) as Iteration

  if (options.runnable) {
    const configured = await request.put(`/api/admin/iterations/${iteration.id}/config`, {
      data: {
        deps_version: 1,
        matches: [{ slots: ['builtin-naive'], seeds: [0], games: 1 }],
      },
    })
    expect(configured.status(), await configured.text()).toBe(200)
  }

  return iteration
}

async function releaseIteration(request: APIRequestContext, iterationId: string): Promise<void> {
  const released = await request.post(`/api/admin/iterations/${iterationId}/release`)
  expect(released.status(), await released.text()).toBe(200)
}

test('released leaderboard history is visible and navigates by iteration URL', async ({
  page,
  request,
}) => {
  const suffix = `${Date.now()}`
  const older = await declareIteration(request, `E2E older ${suffix}`)
  await releaseIteration(request, older.id)
  const newer = await declareIteration(request, `E2E newer ${suffix}`)
  await releaseIteration(request, newer.id)

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
  await declareIteration(request, label, { runnable: true })

  await page.goto(`/environments/${ENV_ID}/admin`)
  await page.getByRole('button', { name: new RegExp(label) }).click()
  await expect(page.getByRole('heading', { name: label })).toBeVisible()

  await page.getByRole('button', { name: 'Run workflow' }).click()
  const logs = page.getByTestId('log-view')
  await expect(logs).toBeVisible({ timeout: 120_000 })
  await expect(logs).toContainText(/\S/)
  await expect(page.getByText('Run completed')).toBeVisible({ timeout: 120_000 })
})
