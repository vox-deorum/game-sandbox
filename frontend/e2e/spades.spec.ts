import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BrowserContext, Locator } from '@playwright/test'
import {
  activeWindows,
  closePlay,
  closeSubmissions,
  configureMatches,
  declareSeason,
  openPlay,
  openSubmissions,
  release,
  setMessagingOverride,
  startSession,
  stopSessionAndAwaitFree,
  submitReadyAgent,
} from './support/api.js'
import { authenticateBrowser } from './support/auth.js'
import { expect, test } from './support/fixtures.js'
import {
  SPADES_ENV_ID,
  SPADES_OWNERS,
  SPADES_SEASON,
  SPECTATOR,
  SPECTATOR_TWO,
} from './support/names.js'
import { TEMPLATE_VERSION } from './support/template-version.js'

/**
 * The focused Stage 8 browser journey. A human in player_0 queues one broadcast and one targeted
 * message before taking the first action. Both messages ride the same recorded tick, while the relay
 * sends only the broadcast to two separately attached spectators. Replay then exposes the complete log,
 * and a directly reopened ended session hydrates the same exchange from the recording. The same
 * container also covers the tick badge and a reconnect leaving no duplicate entries, so the whole
 * journey costs exactly one live container.
 *
 * A second dedicated test exercises the multi-seat matchmaking scheduler with the three `examples/spades`
 * reference agents, mirroring hearts.spec.ts's season arc; the "partners share a team score" assertion
 * reads the shared cross-environment game-over standings (see the test for the exact DOM surface).
 */

const BROADCAST = 'good luck everyone'
const TARGETED = 'partner, cover the ace'

/** Click the bid-1 chip in the Spades renderer's fixed 960 by 720 internal coordinate space. */
async function bidOne(canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox()
  expect(box, 'Spades canvas bounding box').not.toBeNull()
  if (box === null) {
    throw new Error('no Spades canvas bounding box')
  }
  await canvas.click({
    position: {
      x: (372 / 960) * box.width,
      y: (330 / 720) * box.height,
    },
  })
}

test('Spades chat is filtered live and complete in replay', async ({
  page,
  browser,
  admin,
  as,
}) => {
  // A live container session plus three browser contexts (controller + two spectators) and a reopened
  // ended-session revisit needs more room than a DOM-only check.
  test.setTimeout(150_000)

  let sessionId: string | null = null
  let spectatorContext: BrowserContext | null = null
  let spectatorTwoContext: BrowserContext | null = null
  try {
    // Player 0 opens every Spades hand. Making it the human seat keeps the first tick pending until both
    // browsers have attached and the controller has queued the two messages this journey compares. The
    // browser authenticates as the same admin actor that starts the session, so it owns and controls the
    // human seat (the composer and Stop).
    sessionId = await startSession(admin, SPADES_ENV_ID, {
      player_0: { kind: 'human' },
      player_1: { kind: 'builtin-agent' },
      player_2: { kind: 'builtin-agent' },
      player_3: { kind: 'builtin-agent' },
    })
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/sessions/${sessionId}`)
    const canvas = page.locator('canvas.renderer-canvas')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    const controllerChat = page.getByRole('group', { name: 'Chat', exact: true })
    await expect(controllerChat).toBeVisible()

    // Two different browser identities attach before the first step. Both get the read-only panel, and
    // the relay will later deliver the broadcast to each while withholding the targeted message from
    // either — the plan's journey explicitly calls for a *second* spectator page, since one relay
    // fan-out bug could plausibly single out one particular viewer rather than the whole spectator set.
    spectatorContext = await browser.newContext()
    await authenticateBrowser(spectatorContext, await as(SPECTATOR))
    const spectator = await spectatorContext.newPage()
    await spectator.goto(page.url())
    // The panel shell exists before the socket delivers its header. The mounted renderer proves the
    // spectator attachment completed before the controller advances the first tick.
    await expect(spectator.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    const spectatorChat = spectator.getByRole('group', { name: 'Chat log' })
    await expect(spectatorChat).toBeVisible()
    await expect(spectatorChat.getByRole('textbox')).toHaveCount(0)

    spectatorTwoContext = await browser.newContext()
    await authenticateBrowser(spectatorTwoContext, await as(SPECTATOR_TWO))
    const spectatorTwo = await spectatorTwoContext.newPage()
    await spectatorTwo.goto(page.url())
    await expect(spectatorTwo.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    const spectatorTwoChat = spectatorTwo.getByRole('group', { name: 'Chat log' })
    await expect(spectatorTwoChat).toBeVisible()
    await expect(spectatorTwoChat.getByRole('textbox')).toHaveCount(0)

    // Queue one broadcast and one private line for player_2 through the same composer. There is no local
    // echo, so neither appears until bid 1 advances the turn and the harness records both on tick 0.
    const recipient = controllerChat.getByLabel('Recipient')
    const message = controllerChat.getByLabel('Message')
    await recipient.selectOption('')
    await message.fill(BROADCAST)
    await controllerChat.getByRole('button', { name: 'Send' }).click()
    await recipient.selectOption('player_2')
    await message.fill(TARGETED)
    await controllerChat.getByRole('button', { name: 'Send' }).click()
    await expect(controllerChat.getByText(BROADCAST)).toHaveCount(0)
    await expect(controllerChat.getByText(TARGETED)).toHaveCount(0)

    await bidOne(canvas)
    await expect(controllerChat.getByText(BROADCAST)).toBeVisible({ timeout: 30_000 })
    await expect(controllerChat.getByText(TARGETED)).toBeVisible()
    await expect(controllerChat.getByText('from you')).toHaveCount(2)
    // Both messages queued before the human's first action, so both ride the opening tick 0 — the
    // ChatPanel's tick badge is the browser-observable proof of which recorded state carried them.
    await expect(controllerChat.locator('.chat-tick')).toHaveText(['tick 0', 'tick 0'])

    await expect(spectatorChat.getByText(BROADCAST)).toBeVisible()
    await expect(spectatorChat.getByText(TARGETED)).toHaveCount(0)
    await expect(spectatorTwoChat.getByText(BROADCAST)).toBeVisible()
    await expect(spectatorTwoChat.getByText(TARGETED)).toHaveCount(0)
    await spectatorContext.close()
    spectatorContext = null
    await spectatorTwoContext.close()
    spectatorTwoContext = null

    // Reload the controller page mid-session: the socket reattaches. Live chat history is best-effort —
    // the relay replays only its latest state line on attach (LiveSession.attach), and the hand has
    // advanced past the tick that carried these messages, so the resumed live panel legitimately shows
    // none of them (they live in the recording, surfaced by the replay and reopen below). What must hold
    // is that the panel comes back as a live, sendable composer without erroring or duplicating — the
    // deterministic "resumes without duplicating a message" proof is the reopened ended session further
    // down, which rebuilds the full log from the recording archive and shows each message exactly once.
    await page.reload()
    const reloadedChat = page.getByRole('group', { name: 'Chat', exact: true })
    await expect(reloadedChat).toBeVisible({ timeout: 30_000 })
    await expect(reloadedChat.getByRole('button', { name: 'Send' })).toBeVisible()
    // The exact resumed count is timing-dependent (the turn-based live cadence may or may not have
    // advanced the hand past tick 0 by now), but the invariant that guards the bug is that a reconnect
    // never DUPLICATES: the two messages can each appear at most once, never doubling into four rows.
    expect(
      await reloadedChat.locator('.chat-entry').count(),
      'a reconnect must not duplicate chat entries',
    ).toBeLessThanOrEqual(2)

    // The stopped partial hand preserves tick 0. Unlike the live spectator stream, replay exposes both
    // recorded messages immediately and stays read-only.
    await page.getByRole('button', { name: 'Stop' }).click()
    const openReplay = page.getByRole('link', { name: 'Open replay' })
    await expect(openReplay).toBeVisible({ timeout: 60_000 })
    await openReplay.click()

    // The replay merges decisions and chat into one "Game thread"; both messages rode tick 0, where the
    // replay opens, so they show at once, interleaved with the tick's decision and still read-only.
    const replayThread = page.getByRole('group', { name: 'Game thread' })
    await expect(replayThread.getByText(BROADCAST)).toBeVisible()
    await expect(replayThread.getByText(TARGETED)).toBeVisible()
    await expect(replayThread.getByText('broadcast')).toBeVisible()
    await expect(replayThread.getByText('to Player 2')).toBeVisible()
    await expect(replayThread.getByRole('textbox')).toHaveCount(0)

    // Navigate directly to the now-ended session page (not the replay viewer above): SessionPage's
    // hydrateRecording path builds the chat log straight from the parsed recording rather than the live
    // socket, so this exercises a second, independent code path to the same complete, read-only exchange.
    await page.goto(`/sessions/${sessionId}`)
    const reopenedChat = page.getByRole('group', { name: 'Chat log' })
    await expect(reopenedChat.getByText(BROADCAST)).toBeVisible({ timeout: 30_000 })
    await expect(reopenedChat.getByText(TARGETED)).toBeVisible()
    // Exactly two entries, not four: rebuilding the log from the recording archive shows each recorded
    // message once — the deterministic "a reconnected panel resumes without duplicating a message" proof.
    await expect(reopenedChat.locator('.chat-entry')).toHaveCount(2)
    await expect(reopenedChat.getByRole('textbox')).toHaveCount(0)
  } finally {
    // Cleanup is best-effort so a secondary close/delete problem never masks the journey's assertion.
    await spectatorContext?.close().catch(() => {})
    await spectatorTwoContext?.close().catch(() => {})
    if (sessionId !== null) {
      await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
    }
  }
})

test('an over-cap Spades chat draft disables Send', async ({ page, admin }) => {
  // Container launch for a single-composer DOM check.
  test.setTimeout(120_000)

  // The browser authenticates as the same admin actor that starts the session, so it owns and controls
  // the human seat's composer.
  const sessionId = await startSession(admin, SPADES_ENV_ID, {
    player_0: { kind: 'human' },
    player_1: { kind: 'builtin-agent' },
    player_2: { kind: 'builtin-agent' },
    player_3: { kind: 'builtin-agent' },
  })
  try {
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/sessions/${sessionId}`)
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })
    const chat = page.getByRole('group', { name: 'Chat', exact: true })
    await expect(chat).toBeVisible()

    // The Spades environment declares a 120-code-point cap and no season override is in force here, so
    // this session's effective cap is the environment default. A draft one code point over it must
    // disable Send — the DOM proxy for "an over-cap message is rejected" the harness enforces server-side.
    const message = chat.getByLabel('Message')
    const overCapDraft = 'x'.repeat(121)
    await message.fill(overCapDraft)
    // Over the cap the inline counter reddens (the .chat-counter--over modifier) and Send is disabled —
    // the functional proof the composer refuses an over-cap message. The counter is asserted by its
    // content, and Send's disabled state is the real, layout-independent signal.
    await expect(chat.locator('.chat-counter')).toHaveText('121/120')
    await expect(chat.locator('.chat-counter')).toHaveClass(/chat-counter--over/)
    await expect(chat.getByRole('button', { name: 'Send' })).toBeDisabled()

    // Trimming back to exactly the cap clears the over-cap state and re-enables Send — the negative
    // control proving the disablement tracked the draft length, not a stuck state.
    await message.fill(overCapDraft.slice(0, 120))
    await expect(chat.locator('.chat-counter')).toHaveText('120/120')
    await expect(chat.locator('.chat-counter')).not.toHaveClass(/chat-counter--over/)
    await expect(chat.getByRole('button', { name: 'Send' })).toBeEnabled()
  } finally {
    await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
  }
})

test('a season-silenced Spades session mounts no chat panel', async ({ page, admin }) => {
  // Container launch for a single-DOM-absence check.
  test.setTimeout(120_000)

  // The seeded Spades Playground is play-open on a fresh backend; silence its messaging override so the
  // live session it serves mounts no chat, then restore it in `finally` for any later spec.
  const { playSeasonId } = await activeWindows(admin, SPADES_ENV_ID)
  expect(playSeasonId, 'Spades env has an open play season').not.toBeNull()
  const seasonId = playSeasonId
  if (seasonId === null) {
    throw new Error('no open Spades play season to silence')
  }

  await setMessagingOverride(admin, seasonId, false)
  let sessionId: string | null = null
  try {
    sessionId = await startSession(admin, SPADES_ENV_ID, {
      player_0: { kind: 'human' },
      player_1: { kind: 'builtin-agent' },
      player_2: { kind: 'builtin-agent' },
      player_3: { kind: 'builtin-agent' },
    })
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/sessions/${sessionId}`)
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

    // SessionPage.vue guards both the beside and stacked chat panels with `v-if="messagingEnabled"`
    // (reading the session row's resolved `messaging_enabled`): neither the sendable "Chat" composer
    // nor a read-only "Chat log" mounts, the DOM-observable consequence of the override.
    await expect(page.getByRole('group', { name: 'Chat', exact: true })).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Chat log' })).toHaveCount(0)
  } finally {
    if (sessionId !== null) {
      await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
    }
    await setMessagingOverride(admin, seasonId, null).catch(() => {})
  }
})

/** A submittable manifest for a staged example: the standard three fields the validator requires. */
const MANIFEST = `${JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: TEMPLATE_VERSION }, null, 2)}\n`

/** Prune Python bytecode caches while copying: their `.pyc` files never belong in a submission. */
const skipPycache = (src: string): boolean => !/[\\/]__pycache__(?:[\\/]|$)/.test(src)

/** The three example strategies submitted into the matchup, each under its own owner handle. */
const ROSTER = [
  { owner: SPADES_OWNERS.counter, agent: 'counter' },
  { owner: SPADES_OWNERS.daredevil, agent: 'daredevil' },
  { owner: SPADES_OWNERS.signaler, agent: 'signaler' },
] as const

/**
 * Stage an `examples/spades/<name>/` agent as a submittable folder, exactly mirroring hearts.spec.ts's
 * `stageHeartsAgent`: the example's `agent.py`, a generated `manifest.json`, and the composed `sandbox/`
 * helper package its `agent.py` imports (`from sandbox.cards import …`). The example folders are
 * diff-only overlays carrying neither their own manifest nor the `sandbox/` package, both of which the
 * template supplies at compose time, so staging reproduces just those two pieces the way
 * `scripts/compose.py` does: the base layer copied first, then the Spades env layer overlaid whole-file.
 */
function stageSpadesAgent(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `spades-${name}-`))
  const baseSandbox = fileURLToPath(new URL('../../templates/base/sandbox', import.meta.url))
  const envSandbox = fileURLToPath(new URL('../../templates/spades/sandbox', import.meta.url))
  cpSync(baseSandbox, join(dir, 'sandbox'), { recursive: true, filter: skipPycache })
  cpSync(envSandbox, join(dir, 'sandbox'), { recursive: true, force: true, filter: skipPycache })

  const source = fileURLToPath(new URL(`../../examples/spades/${name}/agent.py`, import.meta.url))
  copyFileSync(source, join(dir, 'agent.py'))
  writeFileSync(join(dir, 'manifest.json'), MANIFEST)
  return dir
}

test('a Spades season: three example agents, a scheduled partnership matchup, then release', async ({
  page,
  admin,
  as,
}) => {
  // Three real overlay builds plus a multi-seat schedule of real container games. The matchup below
  // fills the two submission seats with the three ready submissions: with `seat_order_matters=true`
  // Spades' partnership scheduler expands that into P(3,2)=6 ordered seatings, plus the always-appended
  // all-Naive baseline game = 7 full four-seat hands (bid phase + 13 tricks each). That is comparable to
  // Hearts' 13-game schedule, so the budget mirrors hearts.spec.ts's wide window.
  test.setTimeout(1_800_000)

  // The browser drives the admin console as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Stage the three example agents as submittable folders before touching any windows.
  const stagedDirs: string[] = []
  const staged: Record<string, string> = {}
  for (const { agent } of ROSTER) {
    const dir = stageSpadesAgent(agent)
    stagedDirs.push(dir)
    staged[agent] = dir
  }

  // Free the Spades env's single open-submission and open-play slots, held by the seeded Playground.
  const original = await activeWindows(admin, SPADES_ENV_ID)
  if (original.submissionSeasonId !== null) {
    await closeSubmissions(admin, original.submissionSeasonId)
  }
  if (original.playSeasonId !== null) {
    await closePlay(admin, original.playSeasonId)
  }

  const season = await declareSeason(admin, SPADES_SEASON, SPADES_ENV_ID)
  try {
    await openSubmissions(admin, season.id)

    // Each owner submits one example strategy; submissions attach to this now-open season. Building runs
    // a real container per agent.
    await Promise.all(
      ROSTER.map(async (entry) =>
        submitReadyAgent(await as(entry.owner), staged[entry.agent], SPADES_ENV_ID),
      ),
    )

    // The matchup: submission seats at 0 and 2 — Spades' own partnership pairing (`team_of(seat) = seat
    // % 2`), so every scheduled game seats two of the three submissions as PARTNERS against the Naive
    // baseline holding the other partnership (seats 1 and 3). Spades is a four-seat env, so the config
    // must name exactly four slots; `seat_order_matters` makes the scheduler emit one game per ordered
    // pairing of the ready submissions across the two submission seats, plus the appended Naive baseline.
    // Seed 0 is used throughout: which seat opens the bidding is a property of the deal (seat 0 always
    // opens, independent of who is seated there), so the choice of seed does not affect determinism here
    // — it is kept at 0 to match hearts.spec.ts's convention.
    await configureMatches(admin, season.id, [
      {
        slots: ['submission', 'builtin-naive', 'submission', 'builtin-naive'],
        seeds: [0],
        games: 1,
      },
    ])

    // Trigger the run from the operator console. The config was set through the API, so the editor loads
    // clean (not dirty) and the trigger stays enabled; it hands off to the run-details page's live log.
    await page.goto(`/environments/${SPADES_ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(SPADES_SEASON) }).click()
    await expect(page.getByRole('heading', { name: `Season ${SPADES_SEASON}` })).toBeVisible()
    await page.getByRole('button', { name: 'Run workflow' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/environments/${SPADES_ENV_ID}/admin/seasons/${season.id}/runs/`),
    )
    await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 120_000 })
    // Seven four-seat games run serially, several needing a composed multi-submission image, so give the
    // run a wide window before its header status badge settles on completed.
    await expect(page.locator('.run-header .ui-status-badge')).toHaveText('completed', {
      timeout: 1_500_000,
    })

    // Release, then verify the public board the demo serves: a Scoreboard ranking all three agents and
    // the Naive baseline. No ratings were seeded, so the Human Ratings board shows its intentional empty
    // state.
    await release(admin, season.id)
    await page.goto(`/environments/${SPADES_ENV_ID}/leaderboards/${season.id}`)

    const scoreboard = page.locator('section.board', { hasText: 'Scoreboard' })
    const humanBoard = page.locator('section.board', { hasText: 'Human Ratings' })
    await expect(scoreboard.getByText('Naive baseline')).toBeVisible()
    for (const entry of ROSTER) {
      await expect(scoreboard.getByRole('link', { name: entry.owner })).toBeVisible()
    }
    await expect(humanBoard.getByText('No ratings yet.')).toBeVisible()

    // The season's activity counter reflects the automated games the run produced.
    await expect(page.getByText(/[1-9]\d* games run/)).toBeVisible()

    // The public Matchups table lists every game of the run, each with its seats and its own replay
    // link. More than one game proves the multi-seat schedule expanded (seven here: six ordered
    // submission seatings plus the Naive-only baseline).
    const matchups = page.getByRole('region', { name: 'Matchups' })
    await expect(matchups).toBeVisible()
    const gameRows = matchups.getByTestId('game-row')
    expect(await gameRows.count()).toBeGreaterThan(1)

    // "Partners share the team score": open a scheduled game's replay and read the shared
    // cross-environment game-over standings card (frontend/src/components/GameOverCard.vue, built from
    // lib/standings.ts's buildStandings). Its per-row `.value` cell renders the overlay's
    // `display_scores[seat]`, which the Python rules engine (environments/src/spades/overlay.py)
    // documents as "each seat carrying its team's score, so partners share" — so the DOM proof is that
    // the P0 and P2 rows (Spades' team_of(seat) = seat % 2 partnership) show the identical value. That
    // is structural in every Spades game, so the first row is the robust pick; because the all-Naive
    // baseline is appended last, that first row is also one of the permutation games seating the example
    // agents at 0 and 2. The replay viewer's transport has no "jump to end" button, so the terminal
    // frame is reached with the documented End keyboard shortcut on the stage region.
    const submissionGameRow = gameRows.first()
    await expect(submissionGameRow).toBeVisible()
    const replayLink = submissionGameRow.getByRole('link', { name: 'Replay' })
    const replayHref = await replayLink.getAttribute('href')
    expect(replayHref, 'a scheduled game row has a replay link').not.toBeNull()
    if (replayHref === null) {
      throw new Error('no replay href on the scheduled game row')
    }

    await page.goto(replayHref)
    await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

    const stage = page.getByRole('group', { name: 'Replay stage' })
    await stage.click()
    await stage.press('End')
    const gameOver = page.getByRole('dialog', { name: 'Game over' })
    await expect(gameOver).toBeVisible({ timeout: 30_000 })

    const p0Row = gameOver.locator('.row').filter({ hasText: 'P0' })
    const p2Row = gameOver.locator('.row').filter({ hasText: 'P2' })
    await expect(p0Row).toBeVisible()
    await expect(p2Row).toBeVisible()
    const p0Value = await p0Row.locator('.value').innerText()
    const p2Value = await p2Row.locator('.value').innerText()
    expect(p2Value, 'partner seats P0 and P2 share their team score').toBe(p0Value)
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
