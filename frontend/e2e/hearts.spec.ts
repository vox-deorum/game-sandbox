import { rmSync } from 'node:fs'
import type { APIRequestContext, Page } from '@playwright/test'
import {
  activeWindows,
  closePlay,
  closeSubmissions,
  configureMatches,
  declareSeason,
  finishedSeatedSession,
  openPlay,
  openSubmissions,
  release,
  setLlmOverride,
  startSession,
  stopSessionAndAwaitFree,
  submitReadyAgent,
} from './support/api.js'
import { authenticateBrowser, userIdOf } from './support/auth.js'
import { expect, test } from './support/fixtures.js'
import {
  HEARTS_ENV_ID,
  HEARTS_HUMAN_LEAD_SEED,
  HEARTS_OWNERS,
  HEARTS_SEASON,
  LLM_PERSONAS,
} from './support/names.js'
import { stageExampleAgent } from './support/stage-example-agent.js'

/**
 * The dedicated Hearts coverage. Unlike the flappy specs, Hearts is a four-seat, turn-based game, so
 * this spec exercises the two things that only Hearts reaches: the multi-seat matchmaking scheduler
 * (the matchup below fills two seats with submissions and two with the Naive baseline, and the
 * `seat_order_matters` scheduler expands that into one game per ordered seating) and the Hearts
 * renderer in a live four-seat session. The agents are the colocated Hearts reference examples, each
 * a different strategy, submitted into a real season whose released Scoreboard the demo then serves.
 */

/** A four-seat, all-Naive Hearts session: no human seat, so it runs itself to completion (scripted). */
const ALL_BUILTIN_SEATS = {
  seat_0: { kind: 'builtin-agent' as const },
  seat_1: { kind: 'builtin-agent' as const },
  seat_2: { kind: 'builtin-agent' as const },
  seat_3: { kind: 'builtin-agent' as const },
}

/** Two distinct strategies are enough to exercise both ordered two-submission seatings. */
const ROSTER = [
  { owner: HEARTS_OWNERS.oracle, agent: 'oracle' },
  { owner: HEARTS_OWNERS.moonshot, agent: 'moonshot' },
] as const

async function developmentCompletion(actor: APIRequestContext, key: string): Promise<void> {
  const response = await actor.post('/api/llm/v1/chat/completions', {
    headers: { authorization: `Bearer ${key}` },
    data: {
      model: 'small',
      messages: [{ role: 'user', content: '[stub:success] Return one useful sentence.' }],
      max_completion_tokens: 4,
    },
  })
  expect(response.status(), await response.text()).toBe(200)
}

async function openNarrowDecisionLog(page: Page): Promise<void> {
  const disclosure = page.locator('details.stage-log-below', {
    has: page.getByText('Decision log', { exact: true }),
  })
  await disclosure.getByText('Decision log', { exact: true }).click()
  await expect(disclosure).toHaveAttribute('open', '')
}

test('a four-seat Hearts session renders in the browser', async ({ page, admin }) => {
  // Container launch plus the first rendered frame for a four-seat game is slower than a DOM-only check.
  test.setTimeout(120_000)

  // The browser watches as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // The seeded Hearts Playground is play-open on a fresh backend, which is all an all-builtin session
  // needs (no submission seats to attach). Watch it render, the one live-DOM check of the Hearts renderer.
  const sessionId = await startSession(admin, HEARTS_ENV_ID, ALL_BUILTIN_SEATS)
  await page.goto(`/sessions/${sessionId}`)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

  // Free the user's active-session reservation (the scripted game also ends on its own).
  await admin.delete(`/api/sessions/${sessionId}`).catch(() => {})
})

test('a Hearts season: two example agents, a scheduled multi-seat matchup, then release', async ({
  page,
  browser,
  baseURL,
  request,
  admin,
  as,
}) => {
  // Two real overlay builds plus both ordered seatings and the Naive baseline produce three real
  // four-seat container games. This is the minimum roster that still proves seat-order expansion.
  test.setTimeout(900_000)

  // The browser drives the admin console as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Stage both example agents as submittable folders before touching any windows.
  const stagedDirs: string[] = []
  const staged: Record<string, string> = {}
  for (const { agent } of ROSTER) {
    const dir = stageExampleAgent('hearts', agent)
    stagedDirs.push(dir)
    staged[agent] = dir
  }
  const owner = await as(HEARTS_OWNERS.oracle)
  const other = await as(LLM_PERSONAS.other)
  const ownerId = await userIdOf(owner)

  // Free the Hearts environment's open submission and play windows, held by the seeded Playground.
  const original = await activeWindows(admin, HEARTS_ENV_ID)
  if (original.submissionSeasonId !== null) {
    await closeSubmissions(admin, original.submissionSeasonId)
  }
  if (original.playSeasonId !== null) {
    await closePlay(admin, original.playSeasonId)
  }

  const season = await declareSeason(admin, HEARTS_SEASON, HEARTS_ENV_ID)
  try {
    await openSubmissions(admin, season.id)

    // Set the schedule before configuring its model policy. With two submissions, two submitted
    // seats produce both ordered seatings, followed by the Naive-only baseline.
    await configureMatches(admin, season.id, [
      {
        seats: ['submission', 'submission', 'builtin-naive', 'builtin-naive'],
        seeds: [0],
        games: 1,
      },
    ])
    await setLlmOverride(admin, season.id, {
      enabled: true,
      models: ['small'],
      official: { token_budget: 10_000, rate_limit_rpm: 60 },
      development: { token_budget: 10_000, rate_limit_rpm: 60 },
    })

    // Each owner submits one example strategy; submissions attach to this now-open season. Building runs
    // a real container per agent. Oracle is submitted below, after its development-access history closes.
    // The current-season My Agents row is the first key surface. Its secret is read once from the
    // real dialog and then used against the public OpenAI-compatible route.
    await authenticateBrowser(page.context(), owner)
    await page.goto('/my/agents')
    await expect(page.getByRole('meter', { name: 'Development usage' })).toBeVisible()
    await page.getByRole('button', { name: 'Create development key' }).click()
    const credential = page.getByRole('dialog', { name: 'Development credential' })
    await expect(
      credential.getByRole('textbox', { name: 'OPENAI_BASE_URL', exact: true }),
    ).toBeVisible()
    const firstKey = await credential
      .getByRole('textbox', { name: 'OPENAI_API_KEY', exact: true })
      .inputValue()
    await credential.getByRole('button', { name: 'Copy OPENAI_BASE_URL' }).click()
    await credential.getByRole('button', { name: 'Copy OPENAI_API_KEY' }).click()
    await credential.getByRole('button', { name: 'Copy .env' }).click()
    await credential.getByRole('button', { name: 'Done' }).click()
    await expect(credential).toHaveCount(0)

    // Spend against the first key before rotation so the later history assertion proves rotation
    // preserves the participant-season meter instead of merely invalidating an unused credential.
    await developmentCompletion(owner, firstKey)

    // Rotation confirms invalidation before showing the replacement. Closing the second dialog clears
    // the plaintext from the component, then the old credential is rejected by the proxy.
    await page.getByRole('button', { name: 'Rotate development key' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Rotate development key?' })
    await expect(confirmation.getByText('will stop working immediately')).toBeVisible()
    await confirmation.getByRole('button', { name: 'Rotate development key' }).click()
    await expect(credential).toBeVisible()
    const key = await credential
      .getByRole('textbox', { name: 'OPENAI_API_KEY', exact: true })
      .inputValue()
    await credential.getByRole('button', { name: 'Done' }).click()
    const oldKeyResponse = await owner.post('/api/llm/v1/chat/completions', {
      headers: { authorization: `Bearer ${firstKey}` },
      data: { model: 'small', messages: [{ role: 'user', content: 'old key' }] },
    })
    expect(oldKeyResponse.status()).toBe(401)

    const retainedCalls = await owner.get(`/api/seasons/${season.id}/llm-development/calls`)
    expect(retainedCalls.status(), await retainedCalls.text()).toBe(200)
    expect(((await retainedCalls.json()) as { calls: unknown[] }).calls).toHaveLength(1)

    await developmentCompletion(owner, key)
    const ownCalls = await owner.get(`/api/seasons/${season.id}/llm-development/calls`)
    expect(ownCalls.status(), await ownCalls.text()).toBe(200)
    expect(((await ownCalls.json()) as { calls: unknown[] }).calls).toHaveLength(2)
    const otherCalls = await other.get(`/api/seasons/${season.id}/llm-development/calls`)
    expect(otherCalls.status(), await otherCalls.text()).toBe(200)
    expect(((await otherCalls.json()) as { calls: unknown[] }).calls).toHaveLength(0)

    // The active Oracle submission enters the regular roster once this closed-window history check
    // completes. It is not a separate LLM-only session.
    const oracleSubmissionId = await submitReadyAgent(owner, staged.oracle, HEARTS_ENV_ID)
    await closeSubmissions(admin, season.id)
    const closedKeyResponse = await owner.post('/api/llm/v1/chat/completions', {
      headers: { authorization: `Bearer ${key}` },
      data: {
        model: 'small',
        messages: [{ role: 'user', content: '[stub:success] This call must stay blocked.' }],
      },
    })
    expect(closedKeyResponse.status()).toBe(403)
    expect((await closedKeyResponse.json()) as { error: { code?: string } }).toMatchObject({
      error: { code: 'development_closed' },
    })
    await page.goto(`/environments/${HEARTS_ENV_ID}/agents/${ownerId}`)
    await expect(page.getByRole('heading', { name: 'Development access' })).toHaveCount(0)
    const historicalRow = page.locator(`#submission-${oracleSubmissionId}`)
    const historicalHistory = historicalRow.getByRole('button', { name: 'View call history' })
    if (!(await historicalHistory.isVisible())) {
      await historicalRow.locator('.submission-summary').click()
    }
    await historicalHistory.click()
    const historicalDialog = page.getByRole('dialog', { name: 'Development call history' })
    await expect(historicalDialog.getByRole('button', { name: /small/ })).toHaveCount(2)
    await historicalDialog.getByRole('button', { name: 'Close' }).click()
    await openSubmissions(admin, season.id)

    // Operators receive the compact participant table and can open the shared detail dialog.
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/environments/${HEARTS_ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(HEARTS_SEASON) }).click()
    const usage = page.locator('section.admin-section', { hasText: 'Development usage' })
    await expect(usage.getByRole('button', { name: ownerId })).toBeVisible()
    await usage.getByRole('button', { name: ownerId }).click()
    await expect(page.getByRole('dialog', { name: `${ownerId} call history` })).toBeVisible()
    await page.getByRole('button', { name: 'Close' }).click()

    // The owner-facing profile resolves prices and totals, then shows the same private call history.
    await authenticateBrowser(page.context(), owner)
    await page.goto(`/environments/${HEARTS_ENV_ID}/agents/${ownerId}`)
    const development = page.locator('.development-section')
    await expect(development.getByText('Available model tiers')).toBeVisible()
    await expect(development.getByText(/small × 2/)).toBeVisible()
    await development.getByRole('button', { name: 'View call history' }).click()
    const history = page.getByRole('dialog', { name: 'Development call history' })
    const calls = history.getByRole('button', { name: /small/ })
    await expect(calls).toHaveCount(2)
    await calls.first().click()
    await expect(history.getByRole('heading', { name: 'Request', exact: true })).toBeVisible()
    await expect(history.getByRole('heading', { name: 'Response', exact: true })).toBeVisible()
    await history.getByRole('button', { name: 'Close' }).click()

    await Promise.all(
      ROSTER.filter((entry) => entry.agent !== 'oracle').map(async (entry) =>
        submitReadyAgent(await as(entry.owner), staged[entry.agent], HEARTS_ENV_ID),
      ),
    )

    // Trigger the run from the operator console. The config was set through the API, so the editor loads
    // clean (not dirty) and the trigger stays enabled; it hands off to the run-details page's live log.
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/environments/${HEARTS_ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(HEARTS_SEASON) }).click()
    await expect(page.getByRole('heading', { name: `Season ${HEARTS_SEASON}` })).toBeVisible()
    await page.getByRole('button', { name: 'Run workflow' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/environments/${HEARTS_ENV_ID}/admin/seasons/${season.id}/runs/`),
    )
    await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 120_000 })
    // Three four-seat games run serially, and both submitted seatings need a composed multi-submission
    // image. Keep a generous margin for a slow Docker runner without consuming the whole test budget.
    await expect(page.locator('.run-header .ui-status-badge')).toHaveText('completed', {
      timeout: 420_000,
    })

    // Release, then verify the public board the demo serves: a Scoreboard ranking both agents and the
    // Naive baseline. No ratings were seeded, so the Human Ratings board shows its intentional empty state.
    await release(admin, season.id)
    await page.goto(`/environments/${HEARTS_ENV_ID}/leaderboards/${season.id}`)

    const scoreboard = page.locator('section.board', { hasText: 'Scoreboard' })
    const humanBoard = page.locator('section.board', { hasText: 'Human Ratings' })
    await expect(scoreboard.getByText('Naive baseline')).toBeVisible()
    for (const entry of ROSTER) {
      await expect(scoreboard.getByRole('link', { name: entry.owner })).toBeVisible()
    }
    await expect(humanBoard.getByText('No ratings yet.')).toBeVisible()

    // This is a regular mixed season: Oracle has recorded LLM usage from its official workflow
    // calls, including the `small` breakdown, while a conventional strategy reports no usage.
    const oracleBoardRow = scoreboard.locator('tr', {
      has: page.getByRole('link', { name: HEARTS_OWNERS.oracle }),
    })
    const oracleUsage = oracleBoardRow.locator('.llm-usage')
    await expect(oracleUsage).not.toHaveText('None')
    await oracleUsage.getByText('By model', { exact: true }).click()
    await expect(oracleUsage).toContainText(/small: \d+ calls?/)
    const nonLlmBoardRow = scoreboard.locator('tr', {
      has: page.getByRole('link', { name: HEARTS_OWNERS.moonshot }),
    })
    await expect(nonLlmBoardRow.locator('.llm-usage')).toHaveText('None')

    // The Mean score column must show real Hearts scores, not the stale zeros a per-player capture bug
    // once produced (only the player acting on the final trick recorded its score; every other player
    // banked a best-possible 0). A Hearts leaderboard score is the negated penalty total, so each
    // agent's mean lives in the closed range [-26, 0] — a legitimate season that took all 26 penalty
    // points every game sits exactly at the -26 floor, which coincides with the forfeit floor, so the
    // bound is inclusive — and the board as a whole must show points actually changing hands rather than
    // every seat pinned at a perfect 0. The mean cell renders as "mean ± sd" — parseFloat reads the
    // leading signed number and stops at the space, ignoring the spread.
    const meanScores: number[] = []
    for (const entry of ROSTER) {
      const row = scoreboard.locator('tr', { has: page.getByRole('link', { name: entry.owner }) })
      const meanText = await row.locator('td.num').first().innerText()
      const mean = Number.parseFloat(meanText)
      expect(Number.isNaN(mean), `mean for ${entry.owner} parsed from "${meanText}"`).toBe(false)
      expect(mean, `mean score for ${entry.owner}`).toBeLessThanOrEqual(0)
      expect(mean, `mean score for ${entry.owner}`).toBeGreaterThanOrEqual(-26)
      meanScores.push(mean)
    }
    // At least one roster agent took penalty points across its games: a board where every seat reads a
    // perfect 0 would mean scores were not captured (the bug), since the 26 points must land somewhere.
    expect(meanScores.some((mean) => mean < 0)).toBe(true)

    // The season's activity counter reflects the automated games the run produced, not human watch
    // sessions (a competition season runs none): a non-zero "games run" badge despite zero sessions,
    // where the session-only counter once read 0 beside a full board.
    await expect(page.getByText(/[1-9]\d* games run/)).toBeVisible()

    // The Scoreboard carries a per-agent Games column, and every roster row shows a non-zero count —
    // the number of games that agent's mean aggregates, surfaced from the board's own `games` field.
    await expect(scoreboard.getByRole('columnheader', { name: 'Games' })).toBeVisible()
    for (const entry of ROSTER) {
      const row = scoreboard.locator('tr', { has: page.getByRole('link', { name: entry.owner }) })
      // The three numeric cells are Mean score, Agent compute, then Games; the third is the game count.
      const gamesText = await row.locator('td.num').nth(2).innerText()
      expect(Number.parseInt(gamesText, 10), `games count for ${entry.owner}`).toBeGreaterThan(0)
    }

    // The public Matchups table lists every game of the run, each with its seats and its own replay
    // link: how a reader reaches each game of a multi-seat matchup that the board's one representative
    // replay per agent cannot show. Assert the exact three-game schedule and both submitted seat orders
    // so an unordered scheduler regression cannot pass on the Naive baseline alone.
    const matchups = page.getByRole('region', { name: 'Matchups' })
    await expect(matchups).toBeVisible()
    const gameRows = matchups.getByTestId('game-row')
    await expect(gameRows).toHaveCount(3)
    const playerSummaries = await gameRows.locator('td:nth-child(2)').allInnerTexts()
    expect(playerSummaries).toEqual(
      expect.arrayContaining([
        `${HEARTS_OWNERS.oracle} · ${HEARTS_OWNERS.moonshot} · Naive · Naive`,
        `${HEARTS_OWNERS.moonshot} · ${HEARTS_OWNERS.oracle} · Naive · Naive`,
        'Naive · Naive · Naive · Naive',
      ]),
    )
    await expect(matchups.getByRole('link', { name: 'Replay' }).first()).toBeVisible()

    // Use an Oracle game generated by the released workflow, rather than a standalone session, for
    // the owner, operator, and public telemetry boundaries.
    const oracleGame = matchups
      .getByTestId('game-row')
      .filter({ hasText: HEARTS_OWNERS.oracle })
      .first()
    const replayHref = await oracleGame.getByRole('link', { name: 'Replay' }).getAttribute('href')
    expect(replayHref, 'an Oracle workflow game has a replay link').not.toBeNull()
    const recordingId = replayHref?.split('/').at(-1)
    if (recordingId === undefined) throw new Error('Oracle workflow replay id was missing')

    // The submitting owner's agent profile now lists the replays of the games it actually played: the
    // automated competition recordings attach through the run's games (no session), so the session-only
    // replay lookup once showed "No replays yet." here despite a full season of play.
    await page.goto(`/environments/${HEARTS_ENV_ID}/agents/${ownerId}`)
    await expect(page.locator('.submission-replays .replay-chip').first()).toBeVisible({
      timeout: 30_000,
    })

    const ownerTelemetry = await owner.get(`/api/recordings/${recordingId}/llm`)
    expect(ownerTelemetry.status(), await ownerTelemetry.text()).toBe(200)
    const ownerBody = (await ownerTelemetry.json()) as {
      calls: Array<{ request?: unknown; completion?: unknown }>
      total_budget_cost_units: number
    }
    expect(ownerBody.calls.length).toBeGreaterThan(0)
    expect(ownerBody.calls[0]).toHaveProperty('request')
    expect(ownerBody.calls[0]).toHaveProperty('completion')
    const operatorTelemetry = await admin.get(`/api/recordings/${recordingId}/llm`)
    expect(operatorTelemetry.status(), await operatorTelemetry.text()).toBe(200)
    const operatorBody = (await operatorTelemetry.json()) as {
      calls: Array<{ request?: unknown; completion?: unknown }>
    }
    expect(operatorBody.calls[0]).toHaveProperty('request')
    expect(operatorBody.calls[0]).toHaveProperty('completion')
    const publicTelemetry = await request.get(`/api/recordings/${recordingId}/llm`)
    expect(publicTelemetry.status(), await publicTelemetry.text()).toBe(200)
    const publicBody = (await publicTelemetry.json()) as {
      calls: Array<{
        tick: number | null
        model: string
        input_tokens: number
        reasoning_tokens: number
        output_tokens: number
        cost_weight: number
        budget_cost_units: number
        request?: unknown
        completion?: unknown
      }>
      total_budget_cost_units: number
    }
    expect(publicBody.calls.length).toBeGreaterThan(0)
    expect(publicBody.total_budget_cost_units).toBe(ownerBody.total_budget_cost_units)
    expect(publicBody.calls[0]).not.toHaveProperty('request')
    expect(publicBody.calls[0]).not.toHaveProperty('completion')

    await authenticateBrowser(page.context(), owner)
    await page.goto(`/replays/${recordingId}`)
    const log = page.locator('.decision-log')
    await expect(log.getByRole('columnheader', { name: 'LLM cost' })).toBeVisible()
    const recordingTotal = page.getByRole('button', {
      name: 'Show whole-recording LLM cost details',
    })
    await expect(recordingTotal).toContainText(
      `${ownerBody.total_budget_cost_units.toLocaleString()} units`,
    )
    const inspect = log.getByRole('button', { name: 'Inspect request and response' }).first()
    await inspect.click()
    const inspector = page.getByRole('dialog', { name: 'Inspect request and response' })
    await expect(inspector.getByRole('heading', { name: 'Request', exact: true })).toBeVisible()
    await expect(inspector.getByRole('heading', { name: 'Response', exact: true })).toBeVisible()
    await inspector.getByRole('button', { name: 'Close' }).click()

    // Operators retain the same body-inspection capability on the workflow replay UI.
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/replays/${recordingId}`)
    await page
      .locator('.decision-log')
      .getByRole('button', { name: 'Inspect request and response' })
      .first()
      .click()
    const operatorInspector = page.getByRole('dialog', { name: 'Inspect request and response' })
    await expect(
      operatorInspector.getByRole('heading', { name: 'Request', exact: true }),
    ).toBeVisible()
    await expect(
      operatorInspector.getByRole('heading', { name: 'Response', exact: true }),
    ).toBeVisible()
    await operatorInspector.getByRole('button', { name: 'Close' }).click()

    // A logged-out reader retains cost metadata but gets no request or response inspection action.
    await page.context().clearCookies()
    await page.setViewportSize({ width: 480, height: 900 })
    await page.goto(`/replays/${recordingId}`)
    await openNarrowDecisionLog(page)
    const publicLog = page.locator('.decision-log')
    await expect(
      publicLog.getByRole('button', { name: 'Inspect request and response' }),
    ).toHaveCount(0)
    const details = publicLog.getByRole('button', { name: 'LLM cost details' }).first()
    await details.focus()
    const describedBy = await details.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    const tooltip = page.locator(`#${describedBy as string}`)
    await expect(tooltip).toHaveAttribute('role', 'tooltip')
    await expect(tooltip).toContainText('successful call')
    const displayedCall = publicBody.calls.find((call) => call.tick !== null)
    expect(displayedCall).toBeDefined()
    if (displayedCall === undefined) throw new Error('recording had no tick-attributed LLM call')
    await expect(tooltip).toContainText(displayedCall.model)
    await expect(tooltip).toContainText(`${displayedCall.cost_weight} units/token`)
    await expect(tooltip).toContainText(
      `${displayedCall.input_tokens.toLocaleString()} input + ${displayedCall.output_tokens.toLocaleString()} output tokens`,
    )
    await expect(tooltip).toContainText(
      `${displayedCall.reasoning_tokens.toLocaleString()} reasoning tokens within output`,
    )
    await expect(tooltip).toContainText(`${displayedCall.budget_cost_units.toLocaleString()} units`)
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await expect(details).toBeFocused()
    await details.hover()
    await expect(tooltip).toBeVisible()
    await tooltip.hover()
    await page.waitForTimeout(200)
    await expect(tooltip).toBeVisible()

    // Exercise the same disclosure with a real touch-enabled browser context.
    const touchContext = await browser.newContext({
      baseURL: baseURL as string,
      hasTouch: true,
      viewport: { width: 480, height: 900 },
    })
    try {
      const touchPage = await touchContext.newPage()
      await touchPage.goto(`/replays/${recordingId}`)
      await openNarrowDecisionLog(touchPage)
      const touchDetails = touchPage
        .locator('.decision-log')
        .getByRole('button', { name: 'LLM cost details' })
        .first()
      await touchDetails.tap()
      await expect(touchPage.getByRole('tooltip')).toContainText('successful call')
    } finally {
      await touchContext.close()
    }
  } finally {
    // Restore the seeded Playground as the env's open submission+play season for any later spec.
    await closeSubmissions(admin, season.id).catch(() => {})
    await closePlay(admin, season.id).catch(() => {})
    if (original.submissionSeasonId !== null) {
      await openSubmissions(admin, original.submissionSeasonId).catch(() => {})
    }
    if (original.playSeasonId !== null) {
      await openPlay(admin, original.playSeasonId).catch(() => {})
    }
    for (const dir of stagedDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('the watch seat dialog starts a session with the chosen seed reaching the start payload', async ({
  page,
  admin,
}) => {
  // Container launch plus the first rendered frame is slower than a DOM-only check.
  test.setTimeout(120_000)

  // The browser attaches as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Hearts is a four-seat environment, so the watch flow opens the multi-seat SeatAssignmentDialog
  // (WatchAgentPicker routes a single-seat environment straight to a start instead). The seeded Hearts
  // Playground is play-open on a fresh backend, so the watch picker renders for the signed-in admin.
  await page.goto(`/environments/${HEARTS_ENV_ID}`)

  // The built-in Naive row is pinned atop the watch list; its Watch button opens the seat dialog with
  // the Naive baseline preselected into every seat (the default, valid assignment), so Start is enabled
  // without touching a dropdown. Clicking it covers "assign every required seat": all four seats already
  // hold the Naive agent. (The dropdowns are exercised by the play test below.)
  const builtinRow = page.locator('.agent-row').filter({ hasText: 'Naive agent' })
  await builtinRow.getByRole('button', { name: 'Watch' }).click()
  await expect(page.getByRole('heading', { name: 'Watch Hearts' })).toBeVisible()

  // Confirm every seat carries an agent: the four seat dropdowns (labelled "Seat 1".."Seat 4" through
  // their aria-labelledby) all default to the Naive baseline, so the composition is full and valid.
  for (let seat = 1; seat <= 4; seat++) {
    await expect(page.getByLabel(`Seat ${seat}`)).toHaveValue('builtin')
  }

  // A chosen, non-default seed entered into the dialog's seed field. The payload assertion below proves
  // this exact value rode the POST /api/sessions body rather than being dropped or defaulted.
  const chosenSeed = 4242
  await page.getByLabel('Seed (optional)').fill(String(chosenSeed))

  // Start, intercepting the start request so we can read the body the dialog composed. waitForRequest is
  // armed before the click so the request can never slip past us; the request is the authoritative proof
  // the seed reached the wire (the dialog encodes `seed` into the JSON the client POSTs).
  const [startRequest] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('/api/sessions') && req.method() === 'POST'),
    page.getByRole('button', { name: 'Start watching' }).click(),
  ])
  const body = startRequest.postDataJSON() as { env_id: string; seed?: number }
  expect(body.env_id).toBe(HEARTS_ENV_ID)
  expect(body.seed).toBe(chosenSeed)

  // (a) The session started and its Hearts renderer paints: the dialog navigated to the live session and
  // the canvas mounts. This is the DOM-observable consequence of a successful start.
  await expect(page).toHaveURL(/\/sessions\//)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

  // Free the user's active-session reservation (the scripted game also ends on its own).
  const sessionId = page.url().split('/sessions/')[1]
  if (sessionId !== undefined) {
    await admin.delete(`/api/sessions/${sessionId}`).catch(() => {})
  }
})

test('an on-screen human seat plays a legal card and an illegal click does not advance the game', async ({
  page,
  admin,
}) => {
  // Container launch plus driving a couple of live turns is slower than a DOM-only check.
  test.setTimeout(120_000)

  // A live human-vs-agents Hearts session: the connected user (the admin, the operator the browser is
  // authenticated as) controls player_0; the other three seats are built-in agents the container drives.
  // The fixed seed deals player_0 the 2 of clubs, so player_0 leads the very first trick — the
  // deterministic opening where only the 2♣ is legal and every other hand card is greyed. Starting
  // through the API (not the dialog, which the test above covers) pins that seed exactly; a generous
  // move clock keeps the human's turn open long enough to click without the auto-play timeout firing.
  // The browser must authenticate as the same actor that starts the session, so it owns and controls
  // the human seat.
  const sessionId = await startSession(
    admin,
    HEARTS_ENV_ID,
    {
      seat_0: { kind: 'human' },
      seat_1: { kind: 'builtin-agent' },
      seat_2: { kind: 'builtin-agent' },
      seat_3: { kind: 'builtin-agent' },
    },
    { seed: HEARTS_HUMAN_LEAD_SEED, humanTimeoutMs: 60_000 },
  )
  await authenticateBrowser(page.context(), admin)
  await page.goto(`/sessions/${sessionId}`)

  // The renderer mounts and, because the admin owns this human session, the bottom (player_0) hand is
  // interactive: the renderer wires a click-to-play per legal card on the controlled player's turn.
  const canvas = page.locator('canvas.renderer-canvas')
  await expect(canvas).toBeVisible({ timeout: 60_000 })

  // Greying lives in canvas pixels, which the suite never reads, so the assertions are DOM-observable
  // consequences instead. The decision log records one row per acted tick (a play); the opening deal
  // frame carries no action, so the log starts empty. Wait for the renderer to settle (its host reports
  // an aspect ratio and the log mounts) before reading it.
  const decisionRows = page.locator('.decision-log tbody tr')
  await expect(page.locator('.decision-log')).toBeVisible({ timeout: 30_000 })
  await expect(decisionRows).toHaveCount(0)

  // The Hearts table is drawn at a fixed 960x720 internal space the renderer scales onto the canvas, so
  // a click maps from internal coordinates to canvas-relative pixels by the canvas's rendered size. With
  // a 13-card opening hand the fan is laid out left-to-right; the sorted hand puts the 2♣ leftmost, its
  // card rect centered near internal (72, 646), and a far-right card (a clearly-illegal, greyed card)
  // near internal (888, 656). Both centres are derived from scene.ts buildHand's geometry.
  const box = await canvas.boundingBox()
  expect(box, 'canvas bounding box').not.toBeNull()
  if (box === null) {
    throw new Error('no canvas bounding box')
  }
  const at = (internalX: number, internalY: number): { x: number; y: number } => ({
    x: (internalX / 960) * box.width,
    y: (internalY / 720) * box.height,
  })
  const twoOfClubs = at(72, 646)
  const illegalCard = at(888, 656)

  // An illegal click first: a greyed card is not wired clickable (the renderer only binds a play handler
  // to a legal card on the controlled player's turn), so clicking it sends nothing and the game does not
  // advance. The log must still be empty a moment later — the negative control for the legal click.
  await canvas.click({ position: illegalCard })
  // Give any (wrongly) dispatched action time to round-trip and stream a state before asserting no-op.
  await page.waitForTimeout(2000)
  await expect(decisionRows).toHaveCount(0)

  // The legal play: clicking the 2♣ sends its play action for player_0 (the only legal opening card).
  // The backend applies it and the three agent players follow, so the live stream delivers acted states
  // and the decision log grows — the DOM-observable proof that the on-screen human play registered and
  // advanced the hand.
  await canvas.click({ position: twoOfClubs })
  // The decision log growing from empty to one row is the DOM-observable proof the on-screen play
  // registered and advanced the hand. The host renders the controlled player (here player_0, the
  // seed-chosen 2♣ leader) and attributes every log row to it, so this smoke-tests player_0;
  // a per-row player assertion would be tautological, and narrowing controlledPlayers to an arbitrary
  // assigned player is step 6's job. The row-count advance is the honest signal.
  await expect(decisionRows.first()).toBeVisible({ timeout: 30_000 })

  // Stop the still-running human session and wait until the backend frees this user's single active
  // reservation, so the next test's start for the same admin cannot race a 409 already-active.
  await stopSessionAndAwaitFree(admin, sessionId)
})

test('a multi-agent Hearts recording replays with per-player attribution and trick-by-trick playback', async ({
  page,
  admin,
  as,
}) => {
  // One real overlay build plus a full four-seat container hand played to completion, slower than a
  // DOM-only check but far cheaper than the matchup above.
  test.setTimeout(300_000)

  // The browser views the replay as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Stage and submit one example Hearts agent under its own owner, so its player carries a real owner
  // attribution ("<owner>'s agent") in the recording header rather than the generic Naive label. It
  // attaches to the seeded Playground, which is both submission-open and play-open on a fresh backend.
  const stagedDir = stageExampleAgent('hearts', 'duck')
  try {
    const submissionId = await submitReadyAgent(
      await as(HEARTS_OWNERS.replay),
      stagedDir,
      HEARTS_ENV_ID,
    )

    // A scripted four-seat hand: the submitted agent in seat 0, the Naive baseline in the other three.
    // No human seat, so it runs itself to completion and finalizes a trick-by-trick recording. The mixed
    // roster gives the recording header a per-player `players` map with one owner-attributed player and
    // three Naive players. The admin is the operator, so the
    // replay shows real owner labels (the blind-anonymization path applies only to non-operators).
    const recordingId = await finishedSeatedSession(
      admin,
      HEARTS_ENV_ID,
      {
        seat_0: { kind: 'submission', submission_id: submissionId },
        seat_1: { kind: 'builtin-agent' },
        seat_2: { kind: 'builtin-agent' },
        seat_3: { kind: 'builtin-agent' },
      },
      { seed: HEARTS_HUMAN_LEAD_SEED },
    )

    // Open the replay in the viewer and assert it renders the recorded table.
    await page.goto(`/replays/${recordingId}`)
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    const decisionLog = page.locator('.decision-log')
    await expect(decisionLog.getByRole('columnheader', { name: 'LLM cost' })).toBeVisible()
    await expect(decisionLog.getByText('None').first()).toBeVisible()

    // Per-player attribution: the PlayerAttribution line names every player and who drove it. A
    // four-player Hearts recording shows all four players; the submitted player reads the owner's-agent
    // label and the rest read the Naive agent. The final game-over leaderboard reduces those players
    // through the header's seat map.
    const attribution = page.locator('.players')
    await expect(attribution.locator('.player')).toHaveCount(4)
    await expect(attribution.getByText(`${HEARTS_OWNERS.replay}'s agent`)).toBeVisible()
    await expect(attribution.getByText('Naive agent').first()).toBeVisible()

    // Trick-by-trick playback works: the transport's controls are present and stepping forward advances
    // the playhead. The position readout ("tick T · I/N") starts at 1/N and steps to 2/N — the
    // DOM-observable proof the scrubber walks the recorded states.
    const position = page.locator('.replay-position')
    await expect(position).toContainText('1/')
    await page.getByRole('button', { name: 'Step forward' }).click()
    await expect(position).toContainText('2/')
    // The scrubber is the Reka UiSlider (a span with role=slider), present and operable.
    await expect(page.getByRole('slider')).toBeVisible()
  } finally {
    rmSync(stagedDir, { recursive: true, force: true })
  }
})
