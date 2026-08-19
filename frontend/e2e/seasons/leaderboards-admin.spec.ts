import { fileURLToPath } from 'node:url'
import {
  activeWindows,
  closePlay,
  closeSubmissions,
  configureMatches,
  declareSeason,
  deleteSeason,
  getSeasonConfig,
  openPlay,
  openSubmissions,
  type SeededRating,
  seedRatings,
  setAuthorPrompt,
  setSeasonRatingPrompt,
  submitReadyAgent,
} from '../support/api.js'
import { authenticateBrowser, userIdOf } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'
import {
  AUTHOR_RATING_PROMPT,
  ENV_ID,
  JUDGES,
  OPERATOR_RATING_PROMPT,
  OWNERS,
  SEASONS,
} from '../support/names.js'

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/submission/${name}`, import.meta.url))

test('operator season configuration exposes and validates LLM controls', async ({
  page,
  admin,
}) => {
  const season = await declareSeason(admin, 'LLM controls')
  const original = await activeWindows(admin)
  let originalPlayClosed = false
  let configuredPlayOpen = false
  try {
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/environments/${ENV_ID}/admin`)
    await page.getByRole('button', { name: /LLM controls/ }).click()

    const runConfiguration = page.getByRole('heading', { name: 'Run Configuration' }).locator('..')
    await expect(runConfiguration.locator('.ui-card')).toHaveCount(4)
    await expect(
      runConfiguration.getByRole('heading', { name: 'Match Design: 0 submissions' }),
    ).toBeVisible()
    await expect(runConfiguration.getByRole('heading', { name: 'Session Behavior' })).toBeVisible()
    await expect(runConfiguration.getByRole('heading', { name: 'LLM Access' })).toBeVisible()
    await expect(
      runConfiguration.getByRole('heading', { name: 'Environment Parameters' }),
    ).toBeVisible()

    await runConfiguration.getByRole('button', { name: 'Add match' }).click()
    const flatRegions = [
      runConfiguration.getByTestId('match').first(),
      runConfiguration.getByRole('group', { name: 'Per-player limits' }),
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

    // The run controls close the same section, sharing the save action's row. The added match is
    // still unsaved, so the trigger asks before running the persisted configuration.
    const actions = runConfiguration.locator('.config-actions')
    await expect(actions.getByRole('button', { name: 'Save configuration' })).toBeVisible()
    const runWorkflow = actions.getByRole('button', { name: 'Run workflow' })
    await expect(runWorkflow).toBeEnabled()
    await expect(actions.getByRole('button', { name: 'Check leaderboard' })).toBeVisible()
    await runWorkflow.click()
    const unsavedPrompt = page.getByRole('dialog', { name: 'Run with unsaved configuration?' })
    await expect(unsavedPrompt).toBeVisible()
    await unsavedPrompt.getByRole('button', { name: 'Cancel' }).click()
    await expect(unsavedPrompt).toHaveCount(0)

    const messaging = page.getByLabel('Messaging')
    await expect(messaging).toHaveValue('default')
    await expect(messaging.locator('option')).toHaveText(['Environment default (off)', 'Off'])

    const submissions = page.locator('section.admin-section', {
      has: page.getByRole('heading', { name: 'Submissions', exact: true }),
    })
    const downloadAll = submissions.getByRole('link', { name: 'Download all (.tar.gz)' })
    await expect(downloadAll).toHaveClass(/secondary/)
    await expect(downloadAll).toHaveClass(/tight/)
    await expect(downloadAll).toHaveAttribute('download', `season-${season.id.slice(0, 8)}.tar.gz`)
    await expect(submissions.locator('.ui-card')).toHaveCount(0)

    await expect(page.getByLabel('LLM enablement')).toBeVisible()
    const aliases = page.getByLabel('Allowed model aliases')
    await expect(aliases).toBeVisible()
    await expect(aliases.locator('option')).toHaveText([
      'All of them',
      'Medium and small only',
      'Small only',
    ])
    await expect(page.getByLabel('Per-player token budget')).toBeVisible()
    await expect(page.getByLabel('Per-player rate limit (RPM)')).toBeVisible()
    await expect(page.getByLabel('Development token budget')).toBeVisible()
    await expect(page.getByLabel('Development rate limit (RPM)')).toBeVisible()

    await page.getByLabel('Pipe gap', { exact: true }).selectOption('override')
    await page.getByLabel('Pipe gap override').fill('90')
    await page.getByRole('button', { name: 'Save configuration' }).click()
    await expect
      .poll(async () => (await getSeasonConfig(admin, season.id)).overrides?.parameters)
      .toEqual({
        pipe_gap: 90,
      })
    await expect(page.getByLabel('Pipe gap', { exact: true })).toHaveValue('override')
    await expect(page.getByLabel('Pipe gap override')).toHaveValue('90')

    if (original.playSeasonId !== null) {
      await closePlay(admin, original.playSeasonId)
      originalPlayClosed = true
    }
    await openPlay(admin, season.id)
    configuredPlayOpen = true
    const prefill = await admin.get(`/api/environments/${ENV_ID}/play-parameters`)
    const prefillBody = await prefill.text()
    expect(prefill.status(), prefillBody).toBe(200)
    expect((JSON.parse(prefillBody) as { values: { pipe_gap: number } }).values).toEqual({
      players: 1,
      pipe_gap: 90,
    })

    await page.getByLabel('Per-player token budget').fill('0')
    await page.getByRole('button', { name: 'Save configuration' }).click()
    await expect(page.getByText(/official token budget must be a positive integer/)).toBeVisible()
    await page.getByLabel('Per-player token budget').fill('')

    await aliases.selectOption('small')
    await page.getByRole('button', { name: 'Save configuration' }).click()
    await expect
      .poll(async () => (await getSeasonConfig(admin, season.id)).overrides?.llm?.models)
      .toEqual(['small'])

    // Configuration alone does not create activity, so the freshly declared season stays safe to remove.
    expect(season.id).toBeTruthy()
  } finally {
    if (configuredPlayOpen) await closePlay(admin, season.id).catch(() => {})
    if (originalPlayClosed && original.playSeasonId !== null) {
      await openPlay(admin, original.playSeasonId).catch(() => {})
    }
    await deleteSeason(admin, season.id).catch(() => {})
  }
})

/**
 * The peer-rating arc against real data: an operator opens a season, three differently-behaved agents
 * from three owners submit and build, the operator runs the automated workflow over them, then the
 * play window opens and every agent gets a finished, rateable watch session. The season is left
 * unreleased with play open — the glider fully rated by every judge plus the operator, the flapper
 * partially rated, the drifter unrated — so Updraft Open is the demo site's live "ready for peer
 * rating" season (see scripts/demo.py). A peer's written feedback, the agent profiles, and the
 * operator console's Peer Ratings tables are all verified against that state. It is the suite's
 * richest fixture, so it does several real container builds plus a multi-agent run and needs a wide
 * timeout. It borrows the env's single open submission/play windows from the seeded Playground season;
 * at the end it hands the submission window back to Playground but leaves the play window on Updraft
 * Open, which is what the demo serves.
 *
 * Before the field settles, the glider owner (the account `npm run demo` prints for sign-in) submits a
 * first entry that their final agent supersedes, so one profile carries an in-season iteration. That
 * history is verified on the agent profiles at the end. The superseded entry is inactive, so it never
 * runs, places, or changes the boards.
 */
test('a full season: submissions, an automated run, then left open for peer rating', {
  tag: '@slow',
}, async ({ page, admin, as }) => {
  // Four real container builds: the glider owner's superseded first entry plus the three that compete.
  test.setTimeout(900_000)

  // The browser drives the admin console and rates one agent as the bootstrap admin, the operator
  // throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Free the environment's open submission and play windows, held by the seeded Playground season.
  const original = await activeWindows(admin)
  if (original.submissionSeasonId !== null) {
    await closeSubmissions(admin, original.submissionSeasonId)
  }
  if (original.playSeasonId !== null) {
    await closePlay(admin, original.playSeasonId)
  }
  // True once this season's play window opens; the finally leaves play open on it (the ready-for-peer
  // -rating end state) only when we got that far, and otherwise puts Playground's play window back.
  let playOpened = false

  const season = await declareSeason(admin, SEASONS.competition)
  try {
    await openSubmissions(admin, season.id)
    await setSeasonRatingPrompt(admin, season.id, OPERATOR_RATING_PROMPT)

    // Three owners submit agents with distinct flight behaviours, so the boards span a real range.
    // The `raters` count decides how many of the four judges seed each agent: the glider earns the
    // suite's full set, the flapper earns most of one, and the drifter is left unrated so the open
    // season still offers a peer-ratable "Not rated" row.
    const roster = [
      { owner: OWNERS.glider, fixture: 'glider', scores: [5, 5, 4, 5], raters: JUDGES.length },
      { owner: OWNERS.flapper, fixture: 'flapper', scores: [4, 3, 4, 3], raters: 2 },
      { owner: OWNERS.drifter, fixture: 'good', scores: [2, 2, 3, 2], raters: 0 },
    ]

    // A first round the field later replaced. Only the glider owner (the data-rich member the demo
    // mocks) submits here, so exactly one profile carries a superseded entry alongside its current one.
    // The roster agent below supersedes it, so it stays inactive: it never runs, places, or changes the
    // boards, and lives only in the history. Every extra first-round entry would cost a real container
    // build for history no assertion reads, which is why the other two owners submit once.
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
    await configureMatches(admin, season.id, [{ seats: ['submission'], seeds: [0], games: 1 }])

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

    // Open the play window so finished sessions become rateable, then give each agent its seeded
    // rating set (a finished session per agent, voted on by the first `raters` judges). The one with
    // an empty set still gets its finished session — that is what makes the season ready for a peer
    // to come rate it live.
    await openPlay(admin, season.id)
    playOpened = true
    for (const submission of submissions) {
      const raters: SeededRating[] = []
      for (let index = 0; index < submission.raters; index += 1) {
        raters.push({
          ctx: await as(JUDGES[index]),
          score: submission.scores[index] ?? 3,
          feedback: 'Steady under pressure',
        })
      }
      await seedRatings(await as(JUDGES[0]), submission.id, ENV_ID, raters)
    }

    // One rating through the browser, exercising the post-session panel and both rating prompts. The
    // operator has not rated the glider (the four API judges did), so its row action reads "Rate"; a
    // previously-rated agent would read "Watch again". Either way it opens the same parameter dialog,
    // so match the row's single action button by either label and submit the prefilled configuration.
    await page.goto(`/environments/${ENV_ID}`)
    const gliderRow = page.locator('.agent-row').filter({ hasText: OWNERS.glider })
    await expect(gliderRow).toBeVisible()
    await gliderRow.getByRole('button', { name: /Rate|Watch/ }).click()
    await page.getByRole('button', { name: 'Start watching' }).click()
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
    // Every rating needs a written comment, so the save stays disabled until the comment box (ui-textarea)
    // is filled for the watched glider.
    await ratingsPanel.locator('textarea').first().fill('Best run all round')
    await ratingsPanel.getByRole('button', { name: 'Save ratings' }).click()
    await expect(ratingsPanel.getByText('Saved ✓')).toBeVisible()

    // The glider owner is the member the demo mocks, so close the arc on their agent profile: it now
    // carries the richer history this fixture seeds — several submissions in the season, the current
    // one plus the superseded entries it replaced. The profile is keyed on the owner's Better Auth id
    // (the handle is only the display name), and the heading resolves that id back to the display name.
    await page.goto(`/environments/${ENV_ID}/agents/${await userIdOf(await as(OWNERS.glider))}`)
    await expect(
      page.getByRole('heading', { name: `${OWNERS.glider}'s Submissions` }),
    ).toBeVisible()
    // The glider owner is the only one who iterated in-season: one superseded entry plus the current
    // one. The superseded entry carries the "superseded" status badge that the profile folds the old
    // lifecycle marker into.
    await expect(page.locator('.submission-item')).toHaveCount(2)
    await expect(page.getByText('superseded', { exact: true })).toHaveCount(1)

    // A competitor who submitted once shows exactly that: a single entry and no superseded badge.
    await page.goto(`/environments/${ENV_ID}/agents/${await userIdOf(await as(OWNERS.flapper))}`)
    await expect(page.locator('.submission-item')).toHaveCount(1)
    await expect(page.getByText('superseded', { exact: true })).toHaveCount(0)

    // The operator sees the season's peer ratings on the console: both summary tables plus the
    // by-agent drill-in, which names the raters behind each comment. The glider's mean rating is the
    // highest, so its row is the first to open and carries the browser-typed comment above.
    await page.goto(`/environments/${ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(SEASONS.competition) }).click()
    await expect(page.getByRole('heading', { name: `Season ${SEASONS.competition}` })).toBeVisible()
    await expect(page.getByText('Peer Ratings')).toBeVisible()
    const ratingsTables = page.locator('.ratings-tables')
    await expect(ratingsTables).toBeVisible()
    await expect(ratingsTables.getByRole('heading', { name: 'By agent' })).toBeVisible()
    await expect(ratingsTables.getByRole('heading', { name: 'By rater' })).toBeVisible()
    await ratingsTables.locator('.row-open-button').first().click()
    const ratingsDialog = page.getByRole('dialog')
    await expect(ratingsDialog).toBeVisible()
    await expect(ratingsDialog.getByText('Best run all round')).toBeVisible()
    await expect(ratingsDialog.getByText(JUDGES[0], { exact: true })).toBeVisible()
    await ratingsDialog.getByRole('button', { name: 'Close' }).click()
    await expect(ratingsDialog).toHaveCount(0)

    // The season is not released: it stays open for play, ready for peer rating. A plain member (not
    // the operator) sees the Play and Rate section name Updraft Open, with the fully rated glider and
    // the partially rated flapper reading as Rated / Watch again while the unrated drifter still
    // offers the Rate affordance a peer acts on to leave written feedback.
    await authenticateBrowser(page.context(), await as(JUDGES[1]))
    await page.goto(`/environments/${ENV_ID}`)
    await expect(
      page.getByRole('heading', {
        name: `Open for Play: ${SEASONS.competition}`,
        exact: true,
      }),
    ).toBeVisible()
    const playSection = page.locator('section#play')
    await expect(
      playSection.getByRole('heading', {
        name: `Play and Rate: ${SEASONS.competition}`,
      }),
    ).toBeVisible()
    const unratedRow = page.locator('.agent-row').filter({
      has: page.getByText('Not rated', { exact: true }),
    })
    await expect(unratedRow).toBeVisible()
    await expect(unratedRow.getByRole('button', { name: 'Rate' })).toBeVisible()
    await expect(
      page
        .locator('.agent-row')
        .filter({ has: page.getByText('Rated', { exact: true }) })
        .first(),
    ).toBeVisible()
  } finally {
    // Leave Updraft Open as the environment's play-open season — submissions in, play open,
    // unreleased, ready for peer rating — which is the state the demo serves. The submission window
    // goes back to the seeded Playground so Set Up Locally and the submissions group keep their
    // default, while the play window stays on Updraft Open; only if the test never reached openPlay
    // is Playground's play window restored instead.
    await closeSubmissions(admin, season.id).catch(() => {})
    if (original.submissionSeasonId !== null) {
      await openSubmissions(admin, original.submissionSeasonId).catch(() => {})
    }
    if (!playOpened) {
      await closePlay(admin, season.id).catch(() => {})
      if (original.playSeasonId !== null) {
        await openPlay(admin, original.playSeasonId).catch(() => {})
      }
    }
  }
})
