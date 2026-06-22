import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { submitLocal, waitForTerminal } from './support/api.js'
import { ENV_ID, OWNERS } from './support/names.js'

/**
 * The submission journey (Stage 5). It needs a Docker daemon — building an overlay and running the
 * sandboxed load check launch real containers — so it rides the `frontend-e2e` job like the rest of
 * this suite, and the `main` backend is started with `ALLOW_LOCAL_SUBMISSIONS=true` (see
 * playwright.config.ts) so a checked-in fixture folder drives the real pipeline with no network.
 *
 * The form's local-folder field is dev-only (`import.meta.env.DEV`) and so is absent from the
 * production bundle this suite serves; the submission itself is therefore created through the API
 * (which is the real resolve → static → build → load pipeline), and the browser exercises the parts
 * that are only visible there: the agent profile's per-stage timeline.
 *
 * These two owners are dedicated to the pipeline-detail tests and never reused by the leaderboards arc,
 * so each `/agents/<owner>` profile shows exactly one submission with an unambiguous stage timeline.
 * Both submit into whichever season currently holds the open submission window (the seeded Playground).
 */

const GOOD_FIXTURE = fileURLToPath(new URL('./fixtures/submission/good', import.meta.url))
const BAD_CLASS_FIXTURE = fileURLToPath(new URL('./fixtures/submission/bad-class', import.meta.url))

test('a submitted agent validates to ready and runs in a watch session', async ({
  page,
  request,
}) => {
  // The overlay build plus load check plus a real scripted session is well past the default timeout.
  test.setTimeout(240_000)
  const owner = OWNERS.pipeline

  const id = await submitLocal(request, owner, GOOD_FIXTURE)
  const row = await waitForTerminal(request, id)
  expect(row.status, JSON.stringify(row.checks)).toBe('ready')

  // The owner's profile shows every stage of the timeline passed, the in-browser view of "ready".
  await page.goto(`/environments/${ENV_ID}/agents/${owner}`)
  for (const stage of ['resolve', 'static', 'build', 'load']) {
    await expect(page.getByTestId(`stage-${stage}`)).toContainText('passed')
  }

  // The watch picker lists the ready agent; the allowlisted dev user can watch it. Scope to the
  // agent's row so its Watch button is not confused with the pinned built-in Naive agent's.
  await page.goto(`/environments/${ENV_ID}`)
  const row0 = page.locator('.agent-row').filter({ hasText: owner })
  await expect(row0).toBeVisible()
  await row0.getByRole('button', { name: 'Watch' }).click()

  // A real scripted session launches with the built overlay and streams into the renderer.
  await expect(page).toHaveURL(/\/sessions\//)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible()

  // The no-flap agent ends the game on its own; either way the session lands in its terminal state,
  // which the bar marks by surfacing the replay link. Stop a still-running one first.
  const stop = page.getByRole('button', { name: 'Stop' })
  if (await stop.isVisible()) {
    await stop.click({ timeout: 5000 }).catch(() => {})
  }
  await expect(page.getByRole('link', { name: 'Open replay' })).toBeVisible()
})

test('an agent that passes static but fails the load check shows the failed stage on its profile', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  const owner = OWNERS.faulty

  // The manifest names a class the module does not define: static and build pass, the load check
  // rejects with class_not_found.
  const id = await submitLocal(request, owner, BAD_CLASS_FIXTURE)
  const row = await waitForTerminal(request, id)
  expect(row.status, JSON.stringify(row.checks)).toBe('load_failed')

  await page.goto(`/environments/${ENV_ID}/agents/${owner}`)

  // The rollup is visible, the static stage passed, and the load stage failed with the captured
  // Python reason naming the missing class — the same per-stage log the owner would see on the form.
  await expect(page.getByText('load check failed')).toBeVisible()
  await expect(page.getByTestId('stage-static')).toContainText('passed')
  await expect(page.getByTestId('stage-load')).toContainText('failed')
  await expect(page.getByTestId('stage-detail-load')).toContainText('Ghost')
})
