import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
} from './support/names.js'
import { TEMPLATE_VERSION } from './support/template-version.js'

/**
 * The dedicated Hearts coverage. Unlike the flappy specs, Hearts is a four-seat, turn-based game, so
 * this spec exercises the two things that only Hearts reaches: the multi-seat matchmaking scheduler
 * (the matchup below fills two seats with submissions and two with the Naive baseline, and the
 * `seat_order_matters` scheduler expands that into one game per ordered seating) and the Hearts
 * renderer in a live four-seat session. The agents are the `examples/hearts/*` reference agents, each
 * a different strategy, submitted into a real season whose released Scoreboard the demo then serves.
 */

/** A submittable manifest for a staged example: the standard three fields the validator requires. */
const MANIFEST = `${JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: TEMPLATE_VERSION }, null, 2)}\n`

/** A four-seat, all-Naive Hearts session: no human seat, so it runs itself to completion (scripted). */
const ALL_BUILTIN_SEATS = {
  player_0: { kind: 'builtin-agent' as const },
  player_1: { kind: 'builtin-agent' as const },
  player_2: { kind: 'builtin-agent' as const },
  player_3: { kind: 'builtin-agent' as const },
}

/** The four example strategies submitted into the matchup, each under its own owner handle. */
const ROSTER = [
  { owner: HEARTS_OWNERS.duck, agent: 'duck' },
  { owner: HEARTS_OWNERS.moonshot, agent: 'moonshot' },
  { owner: HEARTS_OWNERS.assassin, agent: 'assassin' },
  { owner: HEARTS_OWNERS.closer, agent: 'closer' },
] as const

/** Prune Python bytecode caches while copying: their `.pyc` files never belong in a submission. */
const skipPycache = (src: string): boolean => !/[\\/]__pycache__(?:[\\/]|$)/.test(src)

/**
 * Stage an `examples/hearts/<name>/` agent as a submittable folder that loads exactly like a real
 * submission: its `agent.py`, a generated `manifest.json`, and the composed `sandbox/` helper package
 * its `agent.py` imports (`from sandbox.cards import …`).
 *
 * The example folders are diff-only overlays: they carry neither their own `manifest.json` nor the
 * `sandbox/` package, both of which the template supplies at compose time. So rather than run the full
 * compose pipeline, staging reproduces just those two pieces — the manifest inline, and the `sandbox/`
 * package the way `scripts/compose.py` composes it: the base layer copied first, then the hearts env
 * layer overlaid whole-file (adding `sandbox/cards.py` and the local env). Without the package the load
 * stage cannot import the entry point and the submission fails as `load_failed`. Returns the temp
 * directory's absolute path, which the local-submission source accepts as-is.
 */
function stageHeartsAgent(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hearts-${name}-`))
  const baseSandbox = fileURLToPath(new URL('../../templates/base/sandbox', import.meta.url))
  const envSandbox = fileURLToPath(new URL('../../templates/hearts/sandbox', import.meta.url))
  cpSync(baseSandbox, join(dir, 'sandbox'), { recursive: true, filter: skipPycache })
  cpSync(envSandbox, join(dir, 'sandbox'), { recursive: true, force: true, filter: skipPycache })

  const source = fileURLToPath(new URL(`../../examples/hearts/${name}/agent.py`, import.meta.url))
  copyFileSync(source, join(dir, 'agent.py'))
  writeFileSync(join(dir, 'manifest.json'), MANIFEST)
  return dir
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

  // Free the user's single active-session slot (the scripted game also ends on its own).
  await admin.delete(`/api/sessions/${sessionId}`).catch(() => {})
})

test('a Hearts season: four example agents, a scheduled multi-seat matchup, then release', async ({
  page,
  admin,
  as,
}) => {
  // Four real overlay builds plus a multi-seat schedule of real container games (P(4,2)=12 ordered
  // seatings + the Naive baseline = 13 games), each a full 13-trick hand (52 card plays), so the budget
  // is wide. If CI time becomes a problem, the cheapest lever is fewer submitted agents (see
  // docs/contributors/e2e-tests.md).
  test.setTimeout(1_800_000)

  // The browser drives the admin console as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Stage the four example agents as submittable folders before touching any windows.
  const stagedDirs: string[] = []
  const staged: Record<string, string> = {}
  for (const { agent } of ROSTER) {
    const dir = stageHeartsAgent(agent)
    stagedDirs.push(dir)
    staged[agent] = dir
  }

  // Free the Hearts env's single open-submission and open-play slots, held by the seeded Playground.
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

    // Each owner submits one example strategy; submissions attach to this now-open season. Building runs
    // a real container per agent (duck's load also proves the base image carries its wcwidth dependency).
    await Promise.all(
      ROSTER.map(async (entry) =>
        submitReadyAgent(await as(entry.owner), staged[entry.agent], HEARTS_ENV_ID),
      ),
    )

    // The matchup: two submission seats and two Naive seats. Hearts is a four-seat env, so the config
    // must name exactly four slots; `seat_order_matters` makes the scheduler emit one game per ordered
    // pairing of the ready submissions across the two submission seats, plus the appended Naive baseline.
    await configureMatches(admin, season.id, [
      {
        slots: ['submission', 'submission', 'builtin-naive', 'builtin-naive'],
        seeds: [0],
        games: 1,
      },
    ])

    // Trigger the run from the operator console. The config was set through the API, so the editor loads
    // clean (not dirty) and the trigger stays enabled; it hands off to the run-details page's live log.
    await page.goto(`/environments/${HEARTS_ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(HEARTS_SEASON) }).click()
    await expect(page.getByRole('heading', { name: `Season ${HEARTS_SEASON}` })).toBeVisible()
    await page.getByRole('button', { name: 'Run workflow' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/environments/${HEARTS_ENV_ID}/admin/seasons/${season.id}/runs/`),
    )
    await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 120_000 })
    // Thirteen four-seat games run serially, several needing a composed multi-submission image, so give
    // the run a wide window before its header status badge settles on completed (the flappy arc budgets
    // ~105s per game for a slow runner; this keeps that generous margin for the larger Hearts schedule).
    await expect(page.locator('.run-header .ui-status-badge')).toHaveText('completed', {
      timeout: 1_500_000,
    })

    // Release, then verify the public board the demo serves: a Scoreboard ranking all four agents and the
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

    // The Mean score column must show real Hearts scores, not the stale zeros a per-seat capture bug
    // once produced (only the seat acting on the final trick recorded its score; every other seat
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
    // link — how a reader reaches each game of a multi-seat matchup that the board's one representative
    // replay per agent cannot show. More than one game proves the multi-seat schedule expanded.
    const matchups = page.getByRole('region', { name: 'Matchups' })
    await expect(matchups).toBeVisible()
    expect(await matchups.getByTestId('game-row').count()).toBeGreaterThan(1)
    await expect(matchups.getByRole('link', { name: 'Replay' }).first()).toBeVisible()

    // The submitting owner's agent profile now lists the replays of the games it actually played: the
    // automated competition recordings attach through the run's games (no session), so the session-only
    // replay lookup once showed "No replays yet." here despite a full season of play.
    await page.goto(
      `/environments/${HEARTS_ENV_ID}/agents/${await userIdOf(await as(HEARTS_OWNERS.duck))}`,
    )
    await expect(page.locator('.submission-replays .replay-chip').first()).toBeVisible({
      timeout: 30_000,
    })
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
  // (WatchAgentPicker routes a single-slot env straight to a start instead). The seeded Hearts
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

  // Free the user's single active-session slot (the scripted game also ends on its own).
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
      player_0: { kind: 'human' },
      player_1: { kind: 'builtin-agent' },
      player_2: { kind: 'builtin-agent' },
      player_3: { kind: 'builtin-agent' },
    },
    { seed: HEARTS_HUMAN_LEAD_SEED, humanSlotTimeoutMs: 60_000 },
  )
  await authenticateBrowser(page.context(), admin)
  await page.goto(`/sessions/${sessionId}`)

  // The renderer mounts and, because the admin owns this human session, the bottom (player_0) hand is
  // interactive: the renderer wires a click-to-play per legal card on the controlled seat's turn.
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
  // to a legal card on the controlled seat's turn), so clicking it sends nothing and the game does not
  // advance. The log must still be empty a moment later — the negative control for the legal click.
  await canvas.click({ position: illegalCard })
  // Give any (wrongly) dispatched action time to round-trip and stream a state before asserting no-op.
  await page.waitForTimeout(2000)
  await expect(decisionRows).toHaveCount(0)

  // The legal play: clicking the 2♣ sends its play action for player_0 (the only legal opening card).
  // The backend applies it and the three agent seats follow, so the live stream delivers acted states
  // and the decision log grows — the DOM-observable proof that the on-screen human play registered and
  // advanced the hand.
  await canvas.click({ position: twoOfClubs })
  // The decision log growing from empty to one row is the DOM-observable proof the on-screen play
  // registered and advanced the hand. The host renders the controlled view seat (here player_0, the
  // seed-chosen 2♣ leader) and attributes every log row to it, so this smoke-tests the seat-0 human;
  // a per-row seat assertion would be tautological, and narrowing controlledSlots to an arbitrary
  // assigned seat is step 6's job. The row-count advance is the honest signal.
  await expect(decisionRows.first()).toBeVisible({ timeout: 30_000 })

  // Stop the still-running human session and wait until the backend frees this user's single active
  // slot, so the next test's start for the same admin cannot race a 409 already-active.
  await stopSessionAndAwaitFree(admin, sessionId)
})

test('a multi-agent Hearts recording replays with per-seat attribution and trick-by-trick playback', async ({
  page,
  admin,
  as,
}) => {
  // One real overlay build plus a full four-seat container hand played to completion, slower than a
  // DOM-only check but far cheaper than the matchup above.
  test.setTimeout(300_000)

  // The browser views the replay as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Stage and submit one example Hearts agent under its own owner, so its seat carries a real owner
  // attribution ("<owner>'s agent") in the recording header rather than the generic Naive label. It
  // attaches to the seeded Playground, which is both submission-open and play-open on a fresh backend.
  const stagedDir = stageHeartsAgent('duck')
  try {
    const submissionId = await submitReadyAgent(
      await as(HEARTS_OWNERS.replay),
      stagedDir,
      HEARTS_ENV_ID,
    )

    // A scripted four-seat hand: the submitted agent in seat 0, the Naive baseline in the other three.
    // No human seat, so it runs itself to completion and finalizes a trick-by-trick recording. The mixed
    // roster gives the recording header a per-seat `players` map with one owner-attributed seat and three
    // Naive seats — the four-seat attribution this test asserts. The admin is the operator, so the
    // replay shows real owner labels (the blind-anonymization path applies only to non-operators).
    const recordingId = await finishedSeatedSession(
      admin,
      HEARTS_ENV_ID,
      {
        player_0: { kind: 'submission', submission_id: submissionId },
        player_1: { kind: 'builtin-agent' },
        player_2: { kind: 'builtin-agent' },
        player_3: { kind: 'builtin-agent' },
      },
      { seed: HEARTS_HUMAN_LEAD_SEED },
    )

    // Open the replay in the viewer and assert it renders the recorded table.
    await page.goto(`/replays/${recordingId}`)
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

    // Per-seat attribution: the PlayerAttribution line carries one entry per seat, each naming the slot
    // and who drove it. A four-seat Hearts recording shows all four seats; the submitted seat reads the
    // owner's-agent label and the rest read the Naive agent. (Both the per-slot line and, on the final
    // frame, the game-over leaderboard read the same header `players` map.)
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
