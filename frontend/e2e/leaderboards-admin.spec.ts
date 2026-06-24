import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import {
  activeWindows,
  closePlay,
  closeSubmissions,
  configureMatches,
  declareSeason,
  finishedScriptedSession,
  openPlay,
  openSubmissions,
  rateSession,
  release,
  setAuthorPrompt,
  setSeasonRatingPrompt,
  submitReadyAgent,
} from './support/api.js'
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
  request,
}) => {
  const season = await declareSeason(request, SEASONS.releasedCard)
  await release(request, season.id)

  await page.goto('/seasons')

  const card = page.locator('li').filter({ hasText: SEASONS.releasedCard })
  await expect(card.getByRole('link', { name: 'Results released' })).toBeVisible()
  await expect(card.getByText(/0 Submissions · 0 Sessions Played/)).toBeVisible()
  await expect(card.locator('img.season-thumb')).toBeVisible()
  await expect(card.getByText('Open now')).toHaveCount(0)

  await card.getByRole('link', { name: `Open ${SEASONS.releasedCard}` }).click()
  await expect(page).toHaveURL(new RegExp(`/environments/${ENV_ID}/leaderboards/${season.id}$`))
})

test('released leaderboard history is visible and navigates by season URL', async ({
  page,
  request,
}) => {
  const older = await declareSeason(request, SEASONS.historyOlder)
  await release(request, older.id)
  const newer = await declareSeason(request, SEASONS.historyNewer)
  await release(request, newer.id)

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

test('operator leaderboard history includes unreleased seasons', async ({ page, request }) => {
  const season = await declareSeason(request, SEASONS.operatorPreview)

  await page.goto(`/environments/${ENV_ID}/leaderboards`)

  const link = page.getByRole('link', { name: SEASONS.operatorPreview })
  await expect(link).toBeVisible()
  await link.click()

  await expect(page).toHaveURL(new RegExp(`/environments/${ENV_ID}/leaderboards/${season.id}$`))
  await expect(page.locator('.leaderboards-sub')).toContainText(SEASONS.operatorPreview)
  await expect(page.getByText('Operator preview · unreleased')).toBeVisible()
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
 * supersede, so several owners — including the glider owner the demo mocks under `npm run demo:user` —
 * carry multiple submissions within the season. That richer history is verified on the agent profiles
 * at the end. The superseded entries are inactive, so they never run, place, or change the boards.
 */
test('a full season: submissions, an automated run, several judges rate, then release', async ({
  page,
  request,
}) => {
  // A first round of re-submissions (each competitor replaces an earlier entry) adds real container
  // builds beyond the bare arc, so widen the budget past the original 900s for slow runners.
  test.setTimeout(1_200_000)

  // Free the env's single open-submission and open-play slots, held by the seeded Playground season.
  const original = await activeWindows(request)
  if (original.submissionSeasonId !== null) {
    await closeSubmissions(request, original.submissionSeasonId)
  }
  if (original.playSeasonId !== null) {
    await closePlay(request, original.playSeasonId)
  }

  const season = await declareSeason(request, SEASONS.competition)
  try {
    await openSubmissions(request, season.id)
    await setSeasonRatingPrompt(request, season.id, OPERATOR_RATING_PROMPT)

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
      roster.map((entry) => submitReadyAgent(request, entry.owner, fixturePath(entry.fixture))),
    )
    await submitReadyAgent(request, OWNERS.glider, fixturePath('glider'))

    const submissions = await Promise.all(
      roster.map(async (entry) => ({
        ...entry,
        id: await submitReadyAgent(request, entry.owner, fixturePath(entry.fixture)),
      })),
    )

    // The glider's author leaves their own rating guidance (needs an active submission, just created).
    await setAuthorPrompt(request, season.id, OWNERS.glider, AUTHOR_RATING_PROMPT)

    // One submission seat per game: the scheduler runs each ready agent and appends the Naive baseline.
    await configureMatches(request, season.id, [{ slots: ['submission'], seeds: [0], games: 1 }])

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
    // cap, so give the run a wide window before it reports completion.
    await expect(page.getByText('Run completed')).toBeVisible({ timeout: 420_000 })

    // Open the play window so finished sessions become rateable, then seed each agent's ratings from
    // all four judges (≥3 distinct raters is what earns an agent a rank on the Human Ratings board).
    await openPlay(request, season.id)
    for (const submission of submissions) {
      const sessionId = await finishedScriptedSession(request, JUDGES[0], submission.id)
      await Promise.all(
        JUDGES.map((judge, index) =>
          rateSession(request, judge, sessionId, submission.id, submission.scores[index] ?? 3),
        ),
      )
    }

    // One rating through the browser, exercising the post-session panel and both rating prompts.
    await page.goto(`/environments/${ENV_ID}`)
    const gliderRow = page.locator('.agent-row').filter({ hasText: OWNERS.glider })
    await expect(gliderRow).toBeVisible()
    await gliderRow.getByRole('button', { name: 'Watch' }).click()
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
    await release(request, season.id)
    await page.goto(`/environments/${ENV_ID}/leaderboards/${season.id}`)

    const scoreboard = page.locator('section.board', { hasText: 'Scoreboard' })
    const humanBoard = page.locator('section.board', { hasText: 'Human Ratings' })
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
    // one plus the superseded entries it replaced.
    await page.goto(`/environments/${ENV_ID}/agents/${OWNERS.glider}`)
    await expect(
      page.getByRole('heading', { name: `${OWNERS.glider}'s Submissions` }),
    ).toBeVisible()
    // The glider owner iterated deepest: two superseded entries plus the current one. Each superseded
    // entry carries the "superseded" status badge that the profile folds the old lifecycle marker into.
    await expect(page.locator('.submission-item')).toHaveCount(3)
    await expect(page.getByText('superseded', { exact: true })).toHaveCount(2)

    // The other competitors re-submitted too, so their profiles show the same in-season iteration: one
    // superseded entry and the current one.
    await page.goto(`/environments/${ENV_ID}/agents/${OWNERS.flapper}`)
    await expect(page.locator('.submission-item')).toHaveCount(2)
    await expect(page.getByText('superseded', { exact: true })).toHaveCount(1)
  } finally {
    // Restore the seeded Playground as the env's open submission+play season for the other specs.
    await closeSubmissions(request, season.id).catch(() => {})
    await closePlay(request, season.id).catch(() => {})
    if (original.submissionSeasonId !== null) {
      await openSubmissions(request, original.submissionSeasonId).catch(() => {})
    }
    if (original.playSeasonId !== null) {
      await openPlay(request, original.playSeasonId).catch(() => {})
    }
  }
})
