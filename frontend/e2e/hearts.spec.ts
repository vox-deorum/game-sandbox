import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import {
  activeWindows,
  closePlay,
  closeSubmissions,
  configureMatches,
  declareSeason,
  openPlay,
  openSubmissions,
  release,
  startSession,
  submitReadyAgent,
} from './support/api.js'
import { HEARTS_ENV_ID, HEARTS_OWNERS, HEARTS_SEASON } from './support/names.js'

/**
 * The dedicated Hearts coverage. Unlike the flappy specs, Hearts is a four-seat, turn-based game, so
 * this spec exercises the two things that only Hearts reaches: the multi-seat matchmaking scheduler
 * (the matchup below fills two seats with submissions and two with the Naive baseline, and the
 * `seat_order_matters` scheduler expands that into one game per ordered seating) and the Hearts
 * renderer in a live four-seat session. The agents are the `examples/hearts/*` reference agents, each
 * a different strategy, submitted into a real season whose released Scoreboard the demo then serves.
 */

/** A submittable manifest for a staged example: the standard three fields the validator requires. */
const MANIFEST = `${JSON.stringify({ entry_point: 'agent', class_name: 'Agent', template_version: 1 }, null, 2)}\n`

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

/**
 * Stage an `examples/hearts/<name>/` agent as a submittable folder: its `agent.py` plus a generated
 * `manifest.json`. The example folders themselves stay diff-only overlays (the template supplies their
 * manifest at compose time), so staging is how the e2e submits them directly without composing. Returns
 * the temp directory's absolute path, which the local-submission source accepts as-is.
 */
function stageHeartsAgent(name: string): string {
  const source = fileURLToPath(new URL(`../../examples/hearts/${name}/agent.py`, import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), `hearts-${name}-`))
  copyFileSync(source, join(dir, 'agent.py'))
  writeFileSync(join(dir, 'manifest.json'), MANIFEST)
  return dir
}

test('a four-seat Hearts session renders in the browser', async ({ page, request }) => {
  // Container launch plus the first rendered frame for a four-seat game is slower than a DOM-only check.
  test.setTimeout(120_000)

  // The seeded Hearts Playground is play-open on a fresh backend, which is all an all-builtin session
  // needs (no submission seats to attach). Watch it render, the one live-DOM check of the Hearts renderer.
  const sessionId = await startSession(request, 'dev-user', HEARTS_ENV_ID, ALL_BUILTIN_SEATS)
  await page.goto(`/sessions/${sessionId}`)
  await expect(page.locator('canvas.renderer-canvas')).toBeVisible({ timeout: 60_000 })

  // Free the user's single active-session slot (the scripted game also ends on its own).
  await request.delete(`/api/sessions/${sessionId}`).catch(() => {})
})

test('a Hearts season: four example agents, a scheduled multi-seat matchup, then release', async ({
  page,
  request,
}) => {
  // Four real overlay builds plus a multi-seat schedule of real container games (P(4,2)=12 ordered
  // seatings + the Naive baseline = 13 games), each a full 52-trick hand, so the budget is wide. If CI
  // time becomes a problem, the cheapest lever is fewer submitted agents (see docs/contributors/e2e-tests.md).
  test.setTimeout(1_800_000)

  // Stage the four example agents as submittable folders before touching any windows.
  const stagedDirs: string[] = []
  const staged: Record<string, string> = {}
  for (const { agent } of ROSTER) {
    const dir = stageHeartsAgent(agent)
    stagedDirs.push(dir)
    staged[agent] = dir
  }

  // Free the Hearts env's single open-submission and open-play slots, held by the seeded Playground.
  const original = await activeWindows(request, HEARTS_ENV_ID)
  if (original.submissionSeasonId !== null) {
    await closeSubmissions(request, original.submissionSeasonId)
  }
  if (original.playSeasonId !== null) {
    await closePlay(request, original.playSeasonId)
  }

  const season = await declareSeason(request, HEARTS_SEASON, HEARTS_ENV_ID)
  try {
    await openSubmissions(request, season.id)

    // Each owner submits one example strategy; submissions attach to this now-open season. Building runs
    // a real container per agent (duck's load also proves the base image carries its wcwidth dependency).
    await Promise.all(
      ROSTER.map((entry) =>
        submitReadyAgent(request, entry.owner, staged[entry.agent], HEARTS_ENV_ID),
      ),
    )

    // The matchup: two submission seats and two Naive seats. Hearts is a four-seat env, so the config
    // must name exactly four slots; `seat_order_matters` makes the scheduler emit one game per ordered
    // pairing of the ready submissions across the two submission seats, plus the appended Naive baseline.
    await configureMatches(request, season.id, [
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
    await release(request, season.id)
    await page.goto(`/environments/${HEARTS_ENV_ID}/leaderboards/${season.id}`)

    const scoreboard = page.locator('section.board', { hasText: 'Scoreboard' })
    const humanBoard = page.locator('section.board', { hasText: 'Human Ratings' })
    await expect(scoreboard.getByText('Naive baseline')).toBeVisible()
    for (const entry of ROSTER) {
      await expect(scoreboard.getByRole('link', { name: entry.owner })).toBeVisible()
    }
    await expect(humanBoard.getByText('No ratings yet.')).toBeVisible()
  } finally {
    // Restore the seeded Playground as the env's open submission+play season for any later spec.
    await closeSubmissions(request, season.id).catch(() => {})
    await closePlay(request, season.id).catch(() => {})
    if (original.submissionSeasonId !== null) {
      await openSubmissions(request, original.submissionSeasonId).catch(() => {})
    }
    if (original.playSeasonId !== null) {
      await openPlay(request, original.playSeasonId).catch(() => {})
    }
    for (const dir of stagedDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})
