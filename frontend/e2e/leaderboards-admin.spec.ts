import { fileURLToPath } from 'node:url'
import {
  activeWindows,
  closePlay,
  closeSubmissions,
  configureMatches,
  declareSeason,
  deleteSeason,
  finishedScriptedSession,
  openPlay,
  openSubmissions,
  rateSession,
  release,
  setAuthorPrompt,
  setSeasonRatingPrompt,
  submitReadyAgent,
} from './support/api.js'
import { authenticateBrowser, userIdOf } from './support/auth.js'
import { expect, test } from './support/fixtures.js'
import {
  AUTHOR_RATING_PROMPT,
  ENV_ID,
  JUDGES,
  OPERATOR_RATING_PROMPT,
  OWNERS,
  SEASONS,
} from './support/names.js'

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/submission/${name}`, import.meta.url))

test('the Seasons index shows the refreshed released-season card and navigates to its boards', async ({
  page,
  admin,
}) => {
  const season = await declareSeason(admin, SEASONS.releasedCard)
  await release(admin, season.id)

  // The browser browses as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)
  await page.goto('/seasons')

  const card = page.locator('li').filter({ hasText: SEASONS.releasedCard })
  await expect(card.getByRole('link', { name: 'Results released' })).toBeVisible()
  await expect(card.getByText(/0 Submissions · 0 Games/)).toBeVisible()
  await expect(card.locator('img.season-thumb')).toBeVisible()
  await expect(card.getByText('Open now')).toHaveCount(0)

  await card.getByRole('link', { name: `Open season ${SEASONS.releasedCard}` }).click()
  await expect(page).toHaveURL(new RegExp(`/environments/${ENV_ID}/leaderboards/${season.id}$`))
})

test('released leaderboard history is visible and navigates by season URL', async ({
  page,
  admin,
}) => {
  const older = await declareSeason(admin, SEASONS.historyOlder)
  await release(admin, older.id)
  const newer = await declareSeason(admin, SEASONS.historyNewer)
  await release(admin, newer.id)

  // The browser browses as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)
  await page.goto(`/environments/${ENV_ID}/leaderboards`)

  await expect(page.locator('.leaderboards-sub')).toContainText(SEASONS.historyNewer)
  await expect(page.getByText('Scoreboard')).toBeVisible()
  await expect(page.getByText('Human Ratings')).toBeVisible()
  await expect(page.getByText('No automated results yet.')).toBeVisible()

  const boards = page.locator('.boards > .board')
  const scoreboardBox = await boards.nth(0).boundingBox()
  const ratingsBox = await boards.nth(1).boundingBox()
  expect(scoreboardBox).not.toBeNull()
  expect(ratingsBox).not.toBeNull()
  expect(ratingsBox?.y).toBeGreaterThan((scoreboardBox?.y ?? 0) + (scoreboardBox?.height ?? 0))

  await page.getByRole('link', { name: SEASONS.historyOlder }).click()
  await expect(page).toHaveURL(new RegExp(`/environments/${ENV_ID}/leaderboards/${older.id}$`))
  await expect(page.locator('.leaderboards-sub')).toContainText(SEASONS.historyOlder)
})

test('operator leaderboard history includes unreleased seasons', async ({ page, admin }) => {
  const season = await declareSeason(admin, SEASONS.operatorPreview)
  try {
    // This test depends on the browser being the operator: only the operator's history lists an
    // unreleased season, so the browser authenticates as the bootstrap admin before browsing.
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/environments/${ENV_ID}/leaderboards`)

    const link = page.getByRole('link', { name: SEASONS.operatorPreview })
    await expect(link).toBeVisible()
    await link.click()

    await expect(page).toHaveURL(new RegExp(`/environments/${ENV_ID}/leaderboards/${season.id}$`))
    await expect(page.locator('.leaderboards-sub')).toContainText(SEASONS.operatorPreview)
    await expect(page.getByText('Operator preview · unreleased')).toBeVisible()

    // The fixture has served its purpose. Remove it through the operator UI so the demo keeps only
    // meaningful seasons, and prove the destructive action waits for explicit confirmation.
    await page.goto(`/environments/${ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(SEASONS.operatorPreview) }).click()
    await page.getByRole('button', { name: 'Delete season' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Delete season?' })
    await confirmation.getByRole('button', { name: 'Cancel' }).click()
    await expect(
      page.getByRole('button', { name: new RegExp(SEASONS.operatorPreview) }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Delete season' }).click()
    await confirmation.getByRole('button', { name: 'Delete season' }).click()
    await expect(
      page.getByRole('button', { name: new RegExp(SEASONS.operatorPreview) }),
    ).toHaveCount(0)
  } finally {
    await deleteSeason(admin, season.id).catch(() => {})
  }
})

test('operator season configuration exposes and validates LLM controls', async ({
  page,
  admin,
}) => {
  const season = await declareSeason(admin, 'LLM controls')
  try {
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/environments/${ENV_ID}/admin`)
    await page.getByRole('button', { name: /LLM controls/ }).click()

    const runConfiguration = page.getByRole('heading', { name: 'Run Configuration' }).locator('..')
    await expect(runConfiguration.locator('.ui-card')).toHaveCount(3)
    await expect(runConfiguration.getByRole('heading', { name: 'Match Design' })).toBeVisible()
    await expect(runConfiguration.getByRole('heading', { name: 'Session Behavior' })).toBeVisible()
    await expect(runConfiguration.getByRole('heading', { name: 'LLM Access' })).toBeVisible()

    await runConfiguration.getByRole('button', { name: 'Add match' }).click()
    const flatRegions = [
      runConfiguration.getByTestId('match').first(),
      runConfiguration.getByRole('group', { name: 'Per-slot limits' }),
      runConfiguration.getByRole('group', { name: 'Development per-participant limits' }),
    ]
    for (const region of flatRegions) {
      await expect(region).toHaveCSS('border-top-width', '1px')
      await expect(region).toHaveCSS('border-right-width', '0px')
      await expect(region).toHaveCSS('border-bottom-width', '0px')
      await expect(region).toHaveCSS('border-left-width', '0px')
      await expect(region).toHaveCSS('border-radius', '0px')
    }

    await expect(
      runConfiguration.locator('.ui-card').getByRole('button', { name: 'Save configuration' }),
    ).toHaveCount(0)

    const messaging = page.getByLabel('Messaging')
    await expect(messaging).toHaveValue('default')
    await expect(messaging.locator('option')).toHaveText(['Environment default (off)', 'Off'])

    const submissions = page.locator('section.admin-section', {
      has: page.getByRole('heading', { name: 'Submissions' }),
    })
    const downloadAll = submissions.getByRole('link', { name: 'Download all (.tar.gz)' })
    await expect(downloadAll).toHaveClass(/secondary/)
    await expect(downloadAll).toHaveClass(/tight/)
    await expect(downloadAll).toHaveAttribute('download', `season-${season.id.slice(0, 8)}.tar.gz`)
    await expect(submissions.locator('.ui-card')).toHaveCount(0)

    await expect(page.getByLabel('LLM enablement')).toBeVisible()
    await expect(page.getByLabel('Allowed model aliases')).toBeVisible()
    await expect(page.getByLabel('Per-slot token budget')).toBeVisible()
    await expect(page.getByLabel('Per-slot rate limit (RPM)')).toBeVisible()
    await expect(page.getByLabel('Development token budget')).toBeVisible()
    await expect(page.getByLabel('Development rate limit (RPM)')).toBeVisible()

    await page.getByLabel('Per-slot token budget').fill('0')
    await page.getByRole('button', { name: 'Save configuration' }).click()
    await expect(page.getByText(/official token budget must be a positive integer/)).toBeVisible()
    await page.getByLabel('Per-slot token budget').fill('')

    await page.getByLabel('Allowed model aliases').selectOption('custom')
    await page.getByRole('button', { name: 'Save configuration' }).click()
    await expect(page.getByText(/Select at least one allowed LLM model alias/)).toBeVisible()

    // The validation is local, so the freshly declared season remains empty and safe to remove.
    expect(season.id).toBeTruthy()
  } finally {
    await deleteSeason(admin, season.id).catch(() => {})
  }
})

/**
 * The whole leaderboards arc against real data: an operator opens a season, three differently-behaved
 * agents from three owners submit and build, the operator runs the automated workflow over them, four
 * judges rate them after watch sessions, and the released season shows a populated Scoreboard and a
 * fully ranked Human Ratings board. This is the suite's richest fixture — it is what the demo site
 * serves (see scripts/demo.py) — so it does several real container builds plus a multi-agent run and
 * needs a wide timeout. It borrows the env's single open submission/play windows from the seeded
 * Playground season and restores them at the end so the rest of the suite still sees the default world.
 *
 * Before the field settles, the competitors submit a first round of entries that their final agents
 * supersede, so several owners — including the glider owner whose account `npm run demo` prints for
 * sign-in — carry multiple submissions within the season. That richer history is verified on the agent profiles
 * at the end. The superseded entries are inactive, so they never run, place, or change the boards.
 */
test('a full season: submissions, an automated run, several judges rate, then release', async ({
  page,
  admin,
  as,
}) => {
  // A first round of re-submissions (each competitor replaces an earlier entry) adds real container
  // builds beyond the bare arc, so widen the budget past the original 900s for slow runners.
  test.setTimeout(1_200_000)

  // The browser drives the admin console and rates one agent as the bootstrap admin, the operator
  // throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Free the env's single open-submission and open-play slots, held by the seeded Playground season.
  const original = await activeWindows(admin)
  if (original.submissionSeasonId !== null) {
    await closeSubmissions(admin, original.submissionSeasonId)
  }
  if (original.playSeasonId !== null) {
    await closePlay(admin, original.playSeasonId)
  }

  const season = await declareSeason(admin, SEASONS.competition)
  try {
    await openSubmissions(admin, season.id)
    await setSeasonRatingPrompt(admin, season.id, OPERATOR_RATING_PROMPT)

    // Three owners submit agents with distinct flight behaviours, so the boards span a real range.
    const roster = [
      { owner: OWNERS.glider, fixture: 'glider', scores: [5, 5, 4, 5] },
      { owner: OWNERS.flapper, fixture: 'flapper', scores: [4, 3, 4, 3] },
      { owner: OWNERS.drifter, fixture: 'good', scores: [2, 2, 3, 2] },
    ]

    // A first round the field later replaced: every competitor submits an earlier entry, and the glider
    // owner (the data-rich member the demo mocks) iterates once more — so the season carries a spread of
    // re-submissions across owners. Each owner's roster agent below supersedes their latest entry here,
    // so these stay inactive: they never run, place, or change the boards, living only in the history.
    await Promise.all(
      roster.map(async (entry) =>
        submitReadyAgent(await as(entry.owner), fixturePath(entry.fixture)),
      ),
    )
    await submitReadyAgent(await as(OWNERS.glider), fixturePath('glider'))

    const submissions = await Promise.all(
      roster.map(async (entry) => ({
        ...entry,
        id: await submitReadyAgent(await as(entry.owner), fixturePath(entry.fixture)),
      })),
    )

    // The glider's author leaves their own rating guidance (needs an active submission, just created).
    await setAuthorPrompt(await as(OWNERS.glider), season.id, AUTHOR_RATING_PROMPT)

    // One submission seat per game: the scheduler runs each ready agent and appends the Naive baseline.
    await configureMatches(admin, season.id, [{ slots: ['submission'], seeds: [0], games: 1 }])

    // Trigger the run from the console; it hands off to the run-details page, which owns the live log
    // stream (the redesigned live-log path).
    await page.goto(`/environments/${ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(SEASONS.competition) }).click()
    await expect(page.getByRole('heading', { name: `Season ${SEASONS.competition}` })).toBeVisible()
    await page.getByRole('button', { name: 'Run workflow' }).click()
    // Triggering navigates to the new run's details page, where the container logs stream into a table.
    await expect(page).toHaveURL(
      new RegExp(`/environments/${ENV_ID}/admin/seasons/${season.id}/runs/`),
    )
    await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 120_000 })
    // Four real games (three agents + the Naive baseline); a lively agent can survive near the episode
    // cap, so give the run a wide window before its status badge settles on completed. The run-header
    // badge is the run's own status (not a per-game cell), so it reports the whole run finishing.
    await expect(page.locator('.run-header .ui-status-badge')).toHaveText('completed', {
      timeout: 420_000,
    })

    // Open the play window so finished sessions become rateable, then seed each agent's ratings from
    // all four judges (≥3 distinct raters is what earns an agent a rank on the Human Ratings board).
    await openPlay(admin, season.id)
    for (const submission of submissions) {
      const sessionId = await finishedScriptedSession(await as(JUDGES[0]), submission.id)
      await Promise.all(
        JUDGES.map(async (judge, index) =>
          rateSession(await as(judge), sessionId, submission.id, submission.scores[index] ?? 3),
        ),
      )
    }

    // One rating through the browser, exercising the post-session panel and both rating prompts. The
    // operator has not rated the glider (the four API judges did), so its row action reads "Rate"; a
    // previously-rated agent would read "Watch again". Either way it starts the same scripted watch run,
    // so match the row's single action button by either label.
    await page.goto(`/environments/${ENV_ID}`)
    const gliderRow = page.locator('.agent-row').filter({ hasText: OWNERS.glider })
    await expect(gliderRow).toBeVisible()
    await gliderRow.getByRole('button', { name: /Rate|Watch/ }).click()
    await expect(page).toHaveURL(/\/sessions\//)
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible()
    const stop = page.getByRole('button', { name: 'Stop' })
    if (await stop.isVisible()) {
      await stop.click({ timeout: 5000 }).catch(() => {})
    }
    await expect(page.getByRole('link', { name: 'Open replay' })).toBeVisible()

    const ratingsPanel = page.locator('.ratings')
    await expect(ratingsPanel.getByText(OPERATOR_RATING_PROMPT)).toBeVisible()
    await expect(ratingsPanel.getByText(AUTHOR_RATING_PROMPT)).toBeVisible()
    await ratingsPanel.getByRole('button', { name: '5', exact: true }).first().click()
    await ratingsPanel.getByRole('button', { name: 'Save ratings' }).click()
    await expect(ratingsPanel.getByText('Saved ✓')).toBeVisible()

    // Release, then verify the public boards the demo serves: a populated Scoreboard and a fully
    // ranked Human Ratings board with the glider on top (its mean rating is the highest).
    await release(admin, season.id)
    await page.goto(`/environments/${ENV_ID}/leaderboards/${season.id}`)

    const scoreboard = page.locator('section.board', { hasText: 'Scoreboard' })
    const humanBoard = page.locator('section.board', { hasText: 'Human Ratings' })
    await expect(scoreboard.getByRole('columnheader', { name: 'LLM usage' })).toBeVisible()
    await expect(scoreboard.getByText('None').first()).toBeVisible()
    await expect(humanBoard.getByRole('columnheader', { name: 'LLM usage' })).toHaveCount(0)
    await expect(scoreboard.getByText('Naive baseline')).toBeVisible()
    for (const owner of [OWNERS.glider, OWNERS.flapper, OWNERS.drifter]) {
      await expect(scoreboard.getByRole('link', { name: owner })).toBeVisible()
      await expect(humanBoard.getByRole('link', { name: owner })).toBeVisible()
    }
    await expect(humanBoard.locator('tbody tr')).toHaveCount(3)
    await expect(humanBoard.locator('tbody tr.unranked')).toHaveCount(0)
    // The glider has the highest mean rating, so it holds rank 1 on the Human Ratings board.
    const gliderHumanRow = humanBoard.locator('tbody tr', { hasText: OWNERS.glider })
    await expect(gliderHumanRow.locator('td').first()).toHaveText('1')

    // The glider owner is the member the demo mocks, so close the arc on their agent profile: it now
    // carries the richer history this fixture seeds — several submissions in the season, the current
    // one plus the superseded entries it replaced. The profile is keyed on the owner's Better Auth id
    // (the handle is only the display name), and the heading resolves that id back to the display name.
    await page.goto(`/environments/${ENV_ID}/agents/${await userIdOf(await as(OWNERS.glider))}`)
    await expect(
      page.getByRole('heading', { name: `${OWNERS.glider}'s Submissions` }),
    ).toBeVisible()
    // The glider owner iterated deepest: two superseded entries plus the current one. Each superseded
    // entry carries the "superseded" status badge that the profile folds the old lifecycle marker into.
    await expect(page.locator('.submission-item')).toHaveCount(3)
    await expect(page.getByText('superseded', { exact: true })).toHaveCount(2)

    // The other competitors re-submitted too, so their profiles show the same in-season iteration: one
    // superseded entry and the current one.
    await page.goto(`/environments/${ENV_ID}/agents/${await userIdOf(await as(OWNERS.flapper))}`)
    await expect(page.locator('.submission-item')).toHaveCount(2)
    await expect(page.getByText('superseded', { exact: true })).toHaveCount(1)

    // Restore Playground before checking the glider owner's cross-season index. Updraft Open is now
    // released history, so its successful status stripe must remain visually distinct from the
    // dedicated current-Season stripe on the submission-open Playground row.
    await closeSubmissions(admin, season.id).catch(() => {})
    await closePlay(admin, season.id).catch(() => {})
    if (original.submissionSeasonId !== null) {
      await openSubmissions(admin, original.submissionSeasonId)
    }
    if (original.playSeasonId !== null) {
      await openPlay(admin, original.playSeasonId)
    }
    await authenticateBrowser(page.context(), await as(OWNERS.glider))
    await page.goto('/my/agents')
    const environmentGroup = page.locator('.environment-group').filter({ hasText: 'Flappy Bird' })
    const currentRow = environmentGroup
      .getByRole('link', { name: /Current season Playground/ })
      .locator('..')
      .locator('.season-row')
    const releasedRow = environmentGroup
      .getByRole('link', { name: /Updraft Open ready to compete/ })
      .locator('..')
      .locator('.season-row')
    await expect(currentRow).toHaveClass(/status-current/)
    await expect(releasedRow).toHaveClass(/status-success/)
    const [currentStripe, releasedStripe] = await Promise.all([
      currentRow.evaluate((element) => getComputedStyle(element).borderLeftColor),
      releasedRow.evaluate((element) => getComputedStyle(element).borderLeftColor),
    ])
    const semanticColors = await page.evaluate(() => {
      const probe = document.createElement('span')
      document.body.append(probe)
      probe.style.color = 'var(--color-current)'
      const current = getComputedStyle(probe).color
      probe.style.color = 'var(--color-success)'
      const success = getComputedStyle(probe).color
      probe.remove()
      return { current, success }
    })
    expect(currentStripe).toBe(semanticColors.current)
    expect(releasedStripe).toBe(semanticColors.success)
    expect(currentStripe).not.toBe(releasedStripe)
  } finally {
    // Restore the seeded Playground as the env's open submission+play season for the other specs.
    await closeSubmissions(admin, season.id).catch(() => {})
    await closePlay(admin, season.id).catch(() => {})
    if (original.submissionSeasonId !== null) {
      await openSubmissions(admin, original.submissionSeasonId).catch(() => {})
    }
    if (original.playSeasonId !== null) {
      await openPlay(admin, original.playSeasonId).catch(() => {})
    }
  }
})
