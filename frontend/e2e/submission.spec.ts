import { fileURLToPath } from 'node:url'

import {
  activeWindows,
  setAuthorPrompt,
  setSeasonRatingPrompt,
  submitLocal,
  waitForTerminal,
} from './support/api.js'
import { authenticateBrowser, userIdOf } from './support/auth.js'
import { expect, test } from './support/fixtures.js'
import {
  AUTHOR_RATING_PROMPT,
  ENV_ID,
  JUDGES,
  OPERATOR_RATING_PROMPT,
  OWNERS,
} from './support/names.js'

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

const GOOD_FIXTURE = fileURLToPath(new URL('./fixtures/submission/glider', import.meta.url))
const BAD_CLASS_FIXTURE = fileURLToPath(new URL('./fixtures/submission/bad-class', import.meta.url))

test('a submitted agent validates to ready and runs in a watch session', async ({
  page,
  admin,
  as,
}) => {
  // The overlay build plus load check plus a real scripted session is well past the default timeout.
  test.setTimeout(240_000)
  const owner = OWNERS.pipeline
  const ownerCtx = await as(owner)

  const id = await submitLocal(ownerCtx, GOOD_FIXTURE)
  const row = await waitForTerminal(ownerCtx, id)
  expect(row.status, JSON.stringify(row.checks)).toBe('ready')
  const windows = await activeWindows(admin)
  expect(windows.playSeasonId).not.toBeNull()
  await setSeasonRatingPrompt(admin, windows.playSeasonId as string, OPERATOR_RATING_PROMPT)
  await setAuthorPrompt(ownerCtx, windows.playSeasonId as string, AUTHOR_RATING_PROMPT)

  // Browse as the owner so both student-facing season summaries are exercised with the real row.
  await authenticateBrowser(page.context(), ownerCtx)

  // My Submissions leads with the current season and makes the submission state explicit.
  const ownerId = await userIdOf(ownerCtx)
  await page.goto(`/environments/${ENV_ID}/agents/${ownerId}`)
  const currentSeason = page.locator('#current-season-banner')
  await expect(currentSeason.getByText('Current Season')).toBeVisible()
  await expect(currentSeason.getByText('ready to compete')).toBeVisible()
  await expect(currentSeason.getByText('Not submitted')).toHaveCount(0)

  // My Agents presents the same current-season state as one compact whole-row link back to this season.
  await page.goto('/my/agents')
  const environmentGroup = page.locator('.environment-group').filter({ hasText: 'Flappy Bird' })
  const currentSeasonLink = environmentGroup.getByRole('link', {
    name: /Current season .* ready to compete/,
  })
  const currentSeasonCard = currentSeasonLink.locator('..')
  await expect(currentSeasonCard.getByText('Current season')).toBeAttached()
  await expect(currentSeasonCard.getByText('ready to compete')).toBeVisible()
  await expect(currentSeasonCard.locator('.season-row-date')).toBeVisible()
  await expect(currentSeasonCard.getByRole('meter')).toHaveCount(0)
  await expect(currentSeasonCard.getByRole('button', { name: /development key/i })).toHaveCount(0)
  await expect(currentSeasonCard.getByText(/Submitted/)).toHaveCount(0)
  await currentSeasonLink.click()
  await expect(page).toHaveURL(/\/environments\/flappy_bird\/agents\/.+\?season=/)

  // The whole-row click lands on the matching My Submissions season, whose validation timeline shows
  // every stage passed.
  for (const stage of ['resolve', 'static', 'build', 'load']) {
    await expect(page.getByTestId(`stage-${stage}`)).toContainText('passed')
  }

  // Browse and rate as a regular member, not the operator, so the playable-season anonymity contract
  // is exercised end to end.
  await authenticateBrowser(page.context(), await as(JUDGES[1]))

  // The season section names the play target, while the watch picker lists the ready agent
  // anonymously under that season's name and highlights that it still needs a rating.
  await page.goto(`/environments/${ENV_ID}`)
  await expect(
    page.getByRole('heading', { name: 'Open for Play: Playground', exact: true }),
  ).toBeVisible()
  const playSection = page.locator('section#play')
  await expect(
    playSection.getByRole('heading', { name: 'Play and Rate: Playground' }),
  ).toBeVisible()
  const row0 = page.locator('.agent-row').filter({ hasText: 'Agent 1' })
  await expect(row0).toBeVisible()
  await expect(row0.getByText('Not rated')).toBeVisible()
  await expect(row0.getByText(owner)).toHaveCount(0)
  await expect(row0.locator('code')).toHaveCount(0)
  await row0.getByRole('button', { name: 'Rate' }).click()
  const rateDialog = page.getByRole('dialog', { name: /Rate Flappy Bird/ })
  await expect(rateDialog.getByRole('spinbutton', { name: 'Pipe gap' })).toBeDisabled()
  await expect(rateDialog.getByRole('combobox', { name: 'Seat 1' })).toBeDisabled()
  await expect(rateDialog.getByRole('spinbutton', { name: 'Seed (optional)' })).toBeDisabled()
  await rateDialog.getByRole('button', { name: 'Start watching' }).click()

  // A real scripted session launches with the built overlay and streams into the renderer.
  await expect(page).toHaveURL(/\/sessions\//)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible()
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.overlay-banner')).toHaveText('Paused')
  await expect(page.getByText('Rate the Agents')).toHaveCount(0)

  // Stop the paused run, then the rating panel should reveal immediately above the canvas.
  const stop = page.getByRole('button', { name: 'Stop' })
  await stop.click()
  await expect(page.getByRole('link', { name: 'Open replay' })).toBeVisible()
  const ratingsPanel = page.locator('.ratings-reveal')
  await expect(ratingsPanel).toBeVisible()
  await expect(ratingsPanel).toHaveCSS('transition-property', /grid-template-rows/)
  await expect(ratingsPanel.getByText('Agent 1')).toBeVisible()
  await expect(ratingsPanel.getByText(OPERATOR_RATING_PROMPT)).toBeVisible()
  await expect(ratingsPanel.getByText(AUTHOR_RATING_PROMPT)).toBeVisible()
  const panelBox = await ratingsPanel.boundingBox()
  const canvasBox = await page.locator('canvas.renderer-canvas').boundingBox()
  expect(panelBox).not.toBeNull()
  expect(canvasBox).not.toBeNull()
  expect(panelBox?.y).toBeLessThan(canvasBox?.y ?? 0)

  await ratingsPanel.getByRole('button', { name: '5', exact: true }).click()
  await ratingsPanel.getByRole('button', { name: 'Save ratings' }).click()
  await expect(ratingsPanel.getByText('Saved ✓')).toBeVisible()

  await page.goto(`/environments/${ENV_ID}`)
  const ratedRow = page.locator('.agent-row').filter({ hasText: 'Agent 1' })
  await expect(ratedRow.getByText('Rated')).toBeVisible()
  await expect(ratedRow.getByRole('button', { name: 'Watch again' })).toBeVisible()
})

test('an agent that passes static but fails the load check shows the failed stage on its profile', async ({
  page,
  admin,
  as,
}) => {
  test.setTimeout(180_000)
  const owner = OWNERS.faulty
  const ownerCtx = await as(owner)

  // The manifest names a class the module does not define: static and build pass, the load check
  // rejects with class_not_found.
  const id = await submitLocal(ownerCtx, BAD_CLASS_FIXTURE)
  const row = await waitForTerminal(ownerCtx, id)
  expect(row.status, JSON.stringify(row.checks)).toBe('load_failed')

  // Browse as the operator, so the owner's profile view below sees the real (non-anonymized) data.
  // The profile is keyed on the owner's Better Auth id (the handle is only the display name now).
  await authenticateBrowser(page.context(), admin)
  const ownerId = await userIdOf(ownerCtx)
  await page.goto(`/environments/${ENV_ID}/agents/${ownerId}`)

  // The rollup is visible, the static stage passed, and the load stage failed with the captured
  // Python reason naming the missing class — the same per-stage log the owner would see on the form.
  await expect(page.getByText('load check failed')).toBeVisible()
  await expect(page.getByTestId('stage-static')).toContainText('passed')
  await expect(page.getByTestId('stage-load')).toContainText('failed')
  await expect(page.getByTestId('stage-detail-load')).toContainText('Ghost')
})
