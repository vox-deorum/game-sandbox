import { rmSync } from 'node:fs'

import type { BrowserContext, Locator, Page } from '@playwright/test'
import {
  CARD_W,
  handFanGeometry,
  SMALL_H,
  SMALL_W,
  WIDTH,
} from '../../src/renderers/cards/scene.js'
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
} from '../support/api.js'
import { authenticateBrowser, displayNameOf } from '../support/auth.js'
import { expect, test } from '../support/fixtures.js'
import {
  SPADES_ENV_ID,
  SPADES_OWNERS,
  SPADES_SEASON,
  SPECTATOR,
  SPECTATOR_TWO,
} from '../support/names.js'
import { stageExampleAgent } from '../support/stage-example-agent.js'

/**
 * The focused Stage 8 browser journey. A human in player_0 queues one broadcast and one targeted
 * message before taking the first action. Both messages ride the same recorded tick, while the relay
 * sends only the broadcast to two separately attached spectators. Replay then exposes the complete log,
 * and a directly reopened ended session hydrates the same exchange from the recording. The same
 * container also covers the tick badge and a reconnect leaving no duplicate entries, so the whole
 * journey costs exactly one live container.
 *
 * A second dedicated test exercises the multi-seat matchmaking scheduler with the three colocated Spades
 * reference agents, mirroring hearts.spec.ts's season arc; the "partners share a team score" assertion
 * reads the shared cross-environment game-over standings (see the test for the exact DOM surface).
 */

const BROADCAST = 'good luck everyone'
const TARGETED = 'partner, cover the ace'

function decisionRows(page: Page): Locator {
  return page.locator('.decision-log tbody:last-of-type tr')
}

function humanDecisionRows(page: Page): Locator {
  return decisionRows(page).filter({ hasText: 'P0', hasNotText: '—' })
}

/** Completed decisions for one player, excluding the adapter's actionless frames. */
function playerDecisionRows(page: Page, player: 0 | 2): Locator {
  return decisionRows(page).filter({ hasText: `P${player}`, hasNotText: '—' })
}

/** Track the latest Spades turn directly from the state frames the page receives. */
function trackSpadesTurn(page: Page): () => number | null {
  let turn: number | null = null
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return
      try {
        const frame = JSON.parse(payload) as { overlay?: { turn?: unknown } }
        if (typeof frame.overlay?.turn === 'number') turn = frame.overlay.turn
      } catch {
        // Session-status envelopes and malformed diagnostics are not state frames.
      }
    })
  })
  return () => turn
}

/**
 * Wait until the agent rows have stopped changing and one controlled hand is awaiting an action.
 * The harness advances agent turns on its live cadence, then stays still for a human-controlled turn.
 */
async function waitForControlledTurn(page: Page, currentTurn: () => number | null): Promise<0 | 2> {
  const rows = decisionRows(page)
  let observedCount = -1
  let unchangedSince = Date.now()
  await expect
    .poll(
      async () => {
        const count = await rows.count()
        if (count !== observedCount) {
          observedCount = count
          unchangedSince = Date.now()
        }
        return Date.now() - unchangedSince
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(1_500)
  await expect
    .poll(() => {
      const turn = currentTurn()
      return turn === 0 || turn === 2 ? turn : null
    })
    .not.toBeNull()
  const turn = currentTurn()
  if (turn !== 0 && turn !== 2) throw new Error('no controlled Spades hand is on turn')
  return turn
}

/** The compact North-row card coordinates, derived from the renderer's shared opponent-row layout. */
function northRowGeometry(cardCount: number): { startX: number; step: number; y: number } {
  const step = cardCount > 1 ? Math.min(SMALL_W - 14, Math.floor((WIDTH - 360) / cardCount)) : 0
  const run = step * (cardCount - 1) + SMALL_W
  return {
    startX: Math.floor((WIDTH - run) / 2),
    step,
    y: 166 + SMALL_H / 2,
  }
}

/** Click the bid-1 chip in the Spades renderer's fixed 960 by 720 internal coordinate space. */
async function bidOne(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox()
  expect(box, 'Spades canvas bounding box').not.toBeNull()
  if (box === null) {
    throw new Error('no Spades canvas bounding box')
  }
  const humanDecisions = humanDecisionRows(page)
  const before = await humanDecisions.count()
  await canvas.click({
    position: {
      x: (372 / 960) * box.width,
      y: (330 / 720) * box.height,
    },
  })
  await expect(humanDecisions).toHaveCount(before + 1, { timeout: 30_000 })
}

/** Bid one for whichever self-controlled partnership hand is currently on turn. */
async function bidOneForSelfControlledHand(
  page: Page,
  canvas: Locator,
  currentTurn: () => number | null,
): Promise<0 | 2> {
  const player = await waitForControlledTurn(page, currentTurn)
  const box = await canvas.boundingBox()
  expect(box, 'Spades canvas bounding box').not.toBeNull()
  if (box === null) {
    throw new Error('no Spades canvas bounding box')
  }
  const decisions = playerDecisionRows(page, player)
  const before = await decisions.count()
  await canvas.click({
    position: {
      x: (372 / 960) * box.width,
      y: (330 / 720) * box.height,
    },
  })
  await expect(decisions).toHaveCount(before + 1, { timeout: 30_000 })
  return player
}

/**
 * Try every card in the acting controlled hand. South uses the full fanned hand; North uses its
 * compact, face-up opponent row. Only a legal card advances play.
 */
async function tryPlayLegalCard(
  page: Page,
  canvas: Locator,
  player: 0 | 2,
  cardCount: number,
): Promise<boolean> {
  const box = await canvas.boundingBox()
  expect(box, 'Spades canvas bounding box').not.toBeNull()
  if (box === null) {
    throw new Error('no Spades canvas bounding box')
  }
  const { startX, step, y } =
    player === 0 ? { ...handFanGeometry(cardCount), y: 604 } : northRowGeometry(cardCount)
  const decisions = playerDecisionRows(page, player)
  const before = await decisions.count()

  for (let index = 0; index < cardCount; index += 1) {
    const cardWidth = player === 0 ? CARD_W : SMALL_W
    await canvas.click({
      position: {
        x: ((startX + index * step + cardWidth / 2) / WIDTH) * box.width,
        y: (y / 720) * box.height,
      },
    })
    try {
      await expect(decisions).toHaveCount(before + 1, { timeout: 800 })
      return true
    } catch {
      // This card is illegal. Try the next target.
    }
  }
  return false
}

/** Drive both partnership hands through bidding and all thirteen tricks. */
async function completeSelfControlledSpadesHand(
  page: Page,
  canvas: Locator,
  currentTurn: () => number | null,
): Promise<{ bids: Set<number>; plays: Record<0 | 2, number> }> {
  const composer = page.getByRole('group', { name: 'Chat', exact: true })
  await expect(composer).toBeVisible({ timeout: 30_000 })

  const bids = new Set<number>()
  bids.add(await bidOneForSelfControlledHand(page, canvas, currentTurn))
  bids.add(await bidOneForSelfControlledHand(page, canvas, currentTurn))

  const remaining: Record<0 | 2, number> = { 0: 13, 2: 13 }
  const plays: Record<0 | 2, number> = { 0: 0, 2: 0 }
  while (remaining[0] + remaining[2] > 0) {
    const player = await waitForControlledTurn(page, currentTurn)
    if (!(await tryPlayLegalCard(page, canvas, player, remaining[player]))) {
      throw new Error(`no legal card click advanced controlled Spades hand P${player}`)
    }
    remaining[player] -= 1
    plays[player] += 1
  }
  return { bids, plays }
}

test('Spades watchers see complete chat live and in replay', async ({
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
      seat_0: { kind: 'human', companion: { kind: 'builtin-agent', name: 'naive' } },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
    })
    await authenticateBrowser(page.context(), admin)
    await page.goto(`/sessions/${sessionId}`)
    const canvas = page.locator('canvas.renderer-canvas')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    await expect(
      page.getByRole('img', {
        name: 'Spades table. Wide seats: S0 includes P0 and P2; S1 includes P1 and P3.',
      }),
    ).toBeVisible()
    const controllerChat = page.getByRole('group', { name: 'Chat', exact: true })
    await expect(controllerChat).toBeVisible()

    // Two different browser identities attach before the first step. Both get the read-only panel, and
    // the relay will later deliver the broadcast and targeted message to each. The second watcher page
    // proves the rule applies to the whole watcher set rather than one particular connection.
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

    // The state policy defaults the recipient to the current sender's partner.
    const recipient = controllerChat.getByLabel('Recipient')
    await expect(recipient).toHaveValue('player_2')

    // Queue one broadcast and one targeted line for player_2 through the same composer. There is no local
    // echo, so neither appears until bid 1 advances the turn and the harness records both on tick 0.
    const message = controllerChat.getByLabel('Message')
    await recipient.selectOption('')
    await message.fill(BROADCAST)
    await controllerChat.getByRole('button', { name: 'Send' }).click()
    await recipient.selectOption('player_2')
    await message.fill(TARGETED)
    await controllerChat.getByRole('button', { name: 'Send' }).click()
    await expect(controllerChat.getByText(BROADCAST)).toHaveCount(0)
    await expect(controllerChat.getByText(TARGETED)).toHaveCount(0)

    await bidOne(page, canvas)
    await expect(controllerChat).toBeVisible()
    await expect(controllerChat.getByText(BROADCAST)).toBeVisible({ timeout: 30_000 })
    await expect(controllerChat.getByText(TARGETED)).toBeVisible()
    await expect(controllerChat.getByText('from you')).toHaveCount(2)
    // Both messages queued before the human's first action, so both ride the opening tick 0 — the
    // ChatPanel's tick badge is the browser-observable proof of which recorded state carried them.
    await expect(controllerChat.locator('.chat-tick')).toHaveText(['tick 0', 'tick 0'])

    // Opponent states continue after the bid, but the designated human policy remains present on each
    // one. The composer stays mounted and ordinary state churn does not erase an unsent draft.
    await message.fill('draft across opponent turns')
    await page.waitForTimeout(1_200)
    await expect(controllerChat).toBeVisible()
    await expect(message).toHaveValue('draft across opponent turns')

    await expect(spectatorChat.getByText(BROADCAST)).toBeVisible()
    await expect(spectatorChat.getByText(TARGETED)).toBeVisible()
    await expect(spectatorTwoChat.getByText(BROADCAST)).toBeVisible()
    await expect(spectatorTwoChat.getByText(TARGETED)).toBeVisible()
    await spectatorContext.close()
    spectatorContext = null
    await spectatorTwoContext.close()
    spectatorTwoContext = null

    // Reload the controller page mid-session: the socket reattaches. Live chat history is best-effort:
    // the relay replays only its latest state line on attach (LiveSession.attach), and the hand has
    // advanced past the tick that carried these messages, so the resumed live panel legitimately shows
    // none of them (they live in the recording, surfaced by the replay and reopen below). What must hold
    // is that the panel comes back as a live, sendable composer without erroring or duplicating. The
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

    // The stopped partial hand preserves tick 0. Replay also exposes both recorded messages immediately
    // and stays read-only.
    await page.getByRole('button', { name: 'Stop' }).click()
    const openReplay = page.getByRole('link', { name: 'Open replay' })
    await expect(openReplay).toBeVisible({ timeout: 60_000 })
    await openReplay.click()
    await expect(
      page.getByRole('img', {
        name: 'Spades table. Wide seats: S0 includes P0 and P2; S1 includes P1 and P3.',
      }),
    ).toBeVisible()

    // The replay merges decisions and chat into one "Game thread"; both messages rode tick 0, where the
    // replay opens, so they show at once, interleaved with the tick's decision and still read-only.
    const replayThread = page.getByRole('group', { name: 'Game thread' })
    await expect(replayThread.getByText(BROADCAST)).toBeVisible()
    await expect(replayThread.getByText(TARGETED)).toBeVisible()
    await expect(replayThread.getByText('broadcast')).toBeVisible()
    await expect(replayThread.getByText('to P2')).toBeVisible()
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

/**
 * The solo seat plan seats four independent players, so its results rank every seat on its own. A
 * scripted all-Naive hand reaches that game-over card without a single canvas click, which is why this
 * runs from a finished recording rather than a played session: the partnership plan below already
 * proves the human input wiring, and nothing about seat ranking needs a human to produce it.
 */
test('a scripted solo Spades hand ranks every seat on its own in the replay', async ({
  page,
  admin,
}) => {
  test.setTimeout(180_000)
  await authenticateBrowser(page.context(), admin)

  const recordingId = await finishedSeatedSession(
    admin,
    SPADES_ENV_ID,
    {
      seat_0: { kind: 'builtin-agent', name: 'naive' },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
      seat_2: { kind: 'builtin-agent', name: 'naive' },
      seat_3: { kind: 'builtin-agent', name: 'naive' },
    },
    { seed: 0, parameters: { seat_plan: 'solo' } },
  )

  await page.goto(`/replays/${recordingId}`)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

  // No wide seats on the solo plan, so the table exposes neither the grouping label nor the image role
  // the partnership plan carries. This is also the season-silenced spec's old solo-plan coverage.
  const rendererHost = page.locator('.renderer-host')
  await expect(rendererHost).not.toHaveAttribute('role', 'img')
  await expect(rendererHost).not.toHaveAttribute('aria-label', /Wide seats/)

  const stage = page.getByRole('group', { name: 'Replay stage' })
  await stage.click()
  await stage.press('End')
  const gameOver = page.getByRole('dialog', { name: 'Game over' })
  await expect(gameOver).toBeVisible({ timeout: 30_000 })
  // Four separately ranked rows and no `.members` line: the structural difference from partnership.
  // The winner varies with how the Naive baselines play the deal, so assert the standing exists, not who.
  await expect(gameOver.locator('.row')).toHaveCount(4)
  await expect(gameOver.locator('.members')).toHaveCount(0)
  await expect(gameOver.locator('.winner')).toBeVisible()
})

test('human Spades self-controls both face-up partnership hands to game over', async ({
  page,
  admin,
}) => {
  test.setTimeout(900_000)
  await authenticateBrowser(page.context(), admin)

  const sessionId = await startSession(
    admin,
    SPADES_ENV_ID,
    {
      seat_0: { kind: 'human', companion: { kind: 'self' } },
      seat_1: { kind: 'builtin-agent', name: 'naive' },
    },
    {
      seed: 0,
      humanTimeoutMs: 30_000,
      parameters: { seat_plan: 'partnership' },
    },
  )
  try {
    const currentTurn = trackSpadesTurn(page)
    await page.goto(`/sessions/${sessionId}`)
    const canvas = page.locator('canvas.renderer-canvas')
    await expect(canvas).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.renderer-host')).toHaveAttribute(
      'aria-label',
      'Spades table. Wide seats: S0 includes P0 and P2; S1 includes P1 and P3.',
    )

    // P2 is North from P0's fixed view. Its compact row is a face-up controlled hand: the helper uses
    // its rendered card targets and can advance a turn only through that hand's live input wiring.
    const { bids, plays } = await completeSelfControlledSpadesHand(page, canvas, currentTurn)
    expect(bids).toEqual(new Set([0, 2]))
    expect(plays).toEqual({ 0: 13, 2: 13 })
    await expect(playerDecisionRows(page, 0)).toHaveCount(14)
    await expect(playerDecisionRows(page, 2)).toHaveCount(14)

    const gameOver = page.getByRole('dialog', { name: 'Game over' })
    await expect(gameOver).toBeVisible({ timeout: 60_000 })
    await expect(gameOver.locator('.row')).toHaveCount(2)
    const selfControlledSeat = gameOver.locator('.row').filter({ hasText: 'S0' })
    await expect(selfControlledSeat.locator('.members')).toHaveText('P0, P2')
    // A wide seat reads as its people, not its index: the members line names both hands, and the
    // label above it names who played them. One person played both, so the label is that person once
    // rather than a name repeated.
    await expect(selfControlledSeat.locator('.who > span').first()).toHaveText(
      await displayNameOf(admin),
    )
    await expect(gameOver.locator('.winner')).toHaveText(/S[01] won/)

    // The same standings hydrate from the recording: the replay's own game-over card, reached by
    // seeking to the end, repeats the two-row partnership result the live card just showed.
    await page.getByRole('link', { name: 'Open replay' }).click()
    const stage = page.getByRole('group', { name: 'Replay stage' })
    await stage.click()
    await stage.press('End')
    const replayGameOver = page.getByRole('dialog', { name: 'Game over' })
    await expect(replayGameOver).toBeVisible({ timeout: 30_000 })
    await expect(replayGameOver.locator('.row')).toHaveCount(2)
    await expect(replayGameOver.locator('.winner')).toHaveText(/S[01] won/)
  } finally {
    await stopSessionAndAwaitFree(admin, sessionId).catch(() => {})
  }
})

/**
 * The two example strategies submitted into the matchup, each under its own owner handle. Two is the
 * minimum that still proves ordered-seat expansion, and the pair is chosen to be structurally
 * different: counter bids its hand honestly, signaler talks to its partner through bid and early play.
 */
const ROSTER = [
  { owner: SPADES_OWNERS.counter, agent: 'counter' },
  { owner: SPADES_OWNERS.signaler, agent: 'signaler' },
] as const

test('a Spades season: two example agents, a scheduled partnership matchup, then release', {
  tag: '@slow',
}, async ({ page, admin, as }) => {
  // Two real overlay builds plus a multi-seat schedule of real container games. The matchup below fills
  // the two submission seats with the two ready submissions: with `seat_order_matters=true` Spades'
  // partnership scheduler expands that into P(2,2)=2 ordered seatings, plus the always-appended
  // all-Naive baseline game = 3 full four-seat hands (bid phase + 13 tricks each), matching hearts.
  //
  // Each ordered seating composes its own session image (the warm overlay is reused only for a lone
  // submission in seat_0), so a third agent would cost four more games and four more image builds.
  test.setTimeout(900_000)

  // The browser drives the admin console as the bootstrap admin, the operator throughout this spec.
  await authenticateBrowser(page.context(), admin)

  // Stage both example agents as submittable folders before touching any windows.
  const stagedDirs: string[] = []
  const staged: Record<string, string> = {}
  for (const { agent } of ROSTER) {
    const dir = stageExampleAgent('spades', agent)
    stagedDirs.push(dir)
    staged[agent] = dir
  }

  // Free the Spades environment's open submission and play windows, held by the seeded Playground.
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

    // The matchup assigns submissions to both partnership seats. Each assignment controls the two
    // players named by its resolved seat, so every scheduled game pits the two submissions against one
    // another. `seat_order_matters` makes the scheduler emit one game per ordered pairing of the ready
    // submissions across the two seats, plus the appended Naive baseline.
    // Seed 0 is used throughout: which player opens the bidding is a property of the deal (player 0
    // always opens, independent of who is seated there), so the choice of seed does not affect
    // determinism here. It is kept at 0 to match hearts.spec.ts's convention.
    await configureMatches(admin, season.id, [
      {
        seats: ['submission', 'submission'],
        seeds: [0],
        games: 1,
      },
    ])

    // Trigger the run from the operator console. The config was set through the API, so the editor loads
    // clean (not dirty) and the trigger stays enabled; it hands off to the run-details page's live log.
    await page.goto(`/environments/${SPADES_ENV_ID}/admin`)
    await page.getByRole('button', { name: new RegExp(SPADES_SEASON) }).click()
    await expect(page.getByRole('heading', { name: `Season ${SPADES_SEASON}` })).toBeVisible()
    await expect(page.getByText('Projected total: 3 games', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Run workflow' }).click()
    await expect(page).toHaveURL(
      new RegExp(`/environments/${SPADES_ENV_ID}/admin/seasons/${season.id}/runs/`),
    )
    await expect(page.getByTestId('log-line').first()).toBeVisible({ timeout: 120_000 })
    // Three four-seat games run serially, two needing a composed multi-submission image, so give the
    // run a wide window before its header status badge settles on completed.
    await expect(page.locator('.run-header .ui-status-badge')).toHaveText('completed', {
      timeout: 420_000,
    })

    // Release, then verify the public board the demo serves: a Scoreboard ranking both agents and the
    // Naive baseline. No ratings were seeded, so the Human Ratings board shows its intentional empty
    // state.
    await release(admin, season.id)
    await page.goto(`/environments/${SPADES_ENV_ID}/leaderboards/${season.id}`)

    const scoreboard = page.locator('section.board', { hasText: 'Scoreboard' })
    const humanBoard = page.locator('section.board', { hasText: 'Human Ratings' })
    await expect(scoreboard.getByText('naive')).toBeVisible()
    for (const entry of ROSTER) {
      await expect(scoreboard.getByRole('link', { name: entry.owner })).toBeVisible()
    }
    await expect(humanBoard.getByText('No ratings yet.')).toBeVisible()

    // The season's activity counter reflects the automated games the run produced.
    await expect(page.getByText(/[1-9]\d* games run/)).toBeVisible()

    // The public Matchups table lists every game of the run, each with its seats and its own replay
    // link. More than one game proves the multi-seat schedule expanded (three here: two ordered
    // submission seatings plus the Naive-only baseline).
    const matchups = page.getByRole('region', { name: 'Matchups' })
    await expect(matchups).toBeVisible()
    const gameRows = matchups.getByTestId('game-row')
    expect(await gameRows.count()).toBeGreaterThan(1)

    // "Partners share the team score": open a scheduled game's replay and read the shared
    // cross-environment game-over standings card (frontend/src/components/GameOverCard.vue, built from
    // lib/standings.ts's buildStandings). The card has one row per resolved assignment seat, and each
    // row lists both player members. This proves the two game-rule partners are represented by one
    // assignment and one team score. The replay viewer's transport has no "jump to end" button, so the
    // terminal frame is reached with the documented End keyboard shortcut on the stage region.
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

    const seat0 = gameOver.locator('.row').filter({ hasText: 'S0' })
    const seat1 = gameOver.locator('.row').filter({ hasText: 'S1' })
    await expect(seat0).toBeVisible()
    await expect(seat1).toBeVisible()
    await expect(seat0.locator('.members')).toHaveText('P0, P2')
    await expect(seat1.locator('.members')).toHaveText('P1, P3')
    await expect(gameOver.locator('.row')).toHaveCount(2)
    await expect(gameOver.locator('.winner')).toHaveText(/S[01] won/)
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
