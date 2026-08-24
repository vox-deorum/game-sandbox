import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { APIRequestContext } from '@playwright/test'

import {
  activeWindows,
  closePlay,
  closeSubmissions,
  configureMatches,
  declareSeason,
  type MatchConfig,
  openPlay,
  openSubmissions,
  release,
  type SeededRating,
  seedRatings,
  setAuthorPrompt,
  setLlmOverride,
  setSeasonOverrides,
  startSeasonRun,
  submitReadyAgent,
  waitForRunTerminal,
} from '../support/api.js'
import { type As, expect, test } from '../support/fixtures.js'
import {
  AUTHOR_RATING_PROMPT,
  CRANE_OWNERS,
  ENV_ID,
  HEARTS_ENV_ID,
  HEARTS_OWNERS,
  HEARTS_SEASON,
  JUDGES,
  OWNERS,
  SEASONS,
  SPADES_ENV_ID,
  SPADES_OWNERS,
  SPADES_SEASON,
} from '../support/names.js'
import { stageExampleAgent } from '../support/stage-example-agent.js'

/**
 * The demo fixture seed. Every other group exercises features and leaves a little data behind; the
 * four `@slow` season arcs additionally leave the demo's released and play-open seasons, so a fast
 * frontend-e2e rebuild (which skips the arcs) used to serve a demo with no released season to
 * explore. This group reproduces that fixture state over the API with no browser open, so
 * `npm run demo -- --rerun-e2e` yields the same substantial demo a complete run does.
 *
 * Each test is gated by `E2E_DEMO_SEED`, which scripts/ci.py sets only for that demo fixture
 * rebuild. A complete run, or a developer's `--fast` loop, skips the whole group: the season arcs
 * build the fixture there, and the seed must not double it. The group's name sorts after every other
 * group so the flappy seed's final play-window handover to Updraft Open never lands before the
 * `play` group, whose journey expects the seeded Playground season to still hold the window.
 */

const seedDemo = process.env.E2E_DEMO_SEED === '1'
const SEED_SKIP_REASON =
  'the demo fixture seed runs only on a demo fixture rebuild (E2E_DEMO_SEED=1)'

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/submission/${name}`, import.meta.url))

/**
 * Build one released season with a finished run and a rating set: declare, submit the staged agents,
 * run the schedule, open the play window, seed each agent's ratings through a scripted watch session,
 * and release. This is the hearts/spades/crane arcs' data half without a browser. Restores the
 * environment's seeded Playground windows and deletes the staging dirs before returning.
 */
async function seedReleasedSeason(
  admin: APIRequestContext,
  as: As,
  opts: {
    envId: string
    label: string
    /** The ready submissions the run seats, each with its rating plan. */
    roster: ReadonlyArray<{
      owner: string
      dir: string
      scores: readonly number[]
      raters: number
      seatCount: number
    }>
    matches: readonly MatchConfig[]
    /** A config merge applied after configureMatches (which replaces the whole config). */
    mergeConfig?: (admin: APIRequestContext, seasonId: string) => Promise<void>
  },
): Promise<void> {
  const original = await activeWindows(admin, opts.envId)
  const staged = [...new Set(opts.roster.map((entry) => entry.dir))]
  const season = await declareSeason(admin, opts.label, opts.envId)
  try {
    if (original.submissionSeasonId !== null) {
      await closeSubmissions(admin, original.submissionSeasonId)
    }
    if (original.playSeasonId !== null) {
      await closePlay(admin, original.playSeasonId)
    }
    await openSubmissions(admin, season.id)
    await configureMatches(admin, season.id, [...opts.matches])
    if (opts.mergeConfig !== undefined) {
      await opts.mergeConfig(admin, season.id)
    }
    const submissions: string[] = []
    for (const entry of opts.roster) {
      submissions.push(await submitReadyAgent(await as(entry.owner), entry.dir, opts.envId))
    }
    await startSeasonRun(admin, season.id)
    expect((await waitForRunTerminal(admin, season.id)).status, opts.label).toBe('completed')
    await openPlay(admin, season.id)
    for (const [index, entry] of opts.roster.entries()) {
      const raters: SeededRating[] = []
      for (const [raterIndex, judge] of JUDGES.slice(0, entry.raters).entries()) {
        raters.push({
          ctx: await as(judge),
          score: entry.scores[raterIndex] ?? 4,
          feedback: 'Steady under pressure',
        })
      }
      await seedRatings(
        await as(JUDGES[0]),
        submissions[index],
        opts.envId,
        raters,
        entry.seatCount,
      )
    }
    await release(admin, season.id)
    // A cheap self-check that the seeded release really produced a board: every roster agent places
    // and the run exposed its supervised games. The arcs assert the rendered surfaces in detail.
    const res = await admin.get(`/api/admin/seasons/${season.id}`)
    expect(res.ok(), await res.text()).toBe(true)
    const board = ((await res.json()) as { board: { automated: unknown[]; games: unknown[] } })
      .board
    expect(board.automated.length).toBeGreaterThanOrEqual(opts.roster.length)
    expect(board.games.length).toBeGreaterThan(0)
  } finally {
    await closeSubmissions(admin, season.id).catch(() => {})
    await closePlay(admin, season.id).catch(() => {})
    if (original.submissionSeasonId !== null) {
      await openSubmissions(admin, original.submissionSeasonId).catch(() => {})
    }
    if (original.playSeasonId !== null) {
      await openPlay(admin, original.playSeasonId).catch(() => {})
    }
    for (const dir of staged) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('flappy Updraft Open stays play-open and ready for peer rating', async ({ admin, as }) => {
  test.skip(!seedDemo, SEED_SKIP_REASON)
  // The glider owner's superseded first entry plus the three that compete: four real container builds.
  test.setTimeout(900_000)

  const original = await activeWindows(admin)
  let playOpened = false
  const season = await declareSeason(admin, SEASONS.competition)
  try {
    if (original.submissionSeasonId !== null) {
      await closeSubmissions(admin, original.submissionSeasonId)
    }
    if (original.playSeasonId !== null) {
      await closePlay(admin, original.playSeasonId)
    }
    await openSubmissions(admin, season.id)

    // The glider owner (the demo's ada-lovelace) submits a first entry their current agent supersedes,
    // so the demo student profile carries an in-season iteration beside the competing entry.
    await submitReadyAgent(await as(OWNERS.glider), fixturePath('glider'))
    const roster = [
      { owner: OWNERS.glider, fixture: 'glider', scores: [5, 5, 4, 5], raters: JUDGES.length },
      { owner: OWNERS.flapper, fixture: 'flapper', scores: [4, 3, 4, 3], raters: 2 },
      { owner: OWNERS.drifter, fixture: 'good', scores: [2, 2, 3, 2], raters: 0 },
    ] as const
    const submissions = []
    for (const entry of roster) {
      const id = await submitReadyAgent(await as(entry.owner), fixturePath(entry.fixture))
      submissions.push({ ...entry, id })
    }

    await setAuthorPrompt(await as(OWNERS.glider), season.id, AUTHOR_RATING_PROMPT)
    await configureMatches(admin, season.id, [{ seats: ['submission'], seeds: [0], games: 1 }])
    await startSeasonRun(admin, season.id)
    expect((await waitForRunTerminal(admin, season.id)).status).toBe('completed')

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
  } finally {
    // Hand the submission window back to the seeded Playground but leave the play window on Updraft
    // Open, the demo's live ready-for-peer-rating season. Only if openPlay never ran is Playground's
    // play window restored instead.
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

test('hearts Black Lady Open: both example agents, full ratings, released', async ({
  admin,
  as,
}) => {
  test.skip(!seedDemo, SEED_SKIP_REASON)
  test.setTimeout(900_000)

  const staged = new Map<string, string>()
  for (const agent of ['oracle', 'moonshot'] as const) {
    staged.set(agent, stageExampleAgent('hearts', agent))
  }
  await seedReleasedSeason(admin, as, {
    envId: HEARTS_ENV_ID,
    label: HEARTS_SEASON,
    roster: [
      {
        owner: HEARTS_OWNERS.oracle,
        dir: staged.get('oracle') as string,
        scores: [5, 4, 4, 5],
        raters: 4,
        seatCount: 4,
      },
      {
        owner: HEARTS_OWNERS.moonshot,
        dir: staged.get('moonshot') as string,
        scores: [3, 4, 3, 4],
        raters: 4,
        seatCount: 4,
      },
    ],
    matches: [
      {
        seats: ['submission', 'submission', 'builtin:naive', 'builtin:naive'],
        seeds: [0],
        games: 1,
      },
    ],
    // The same small model policy the arc leaves behind, so the demo board keeps its LLM usage rows.
    mergeConfig: (admin, seasonId) =>
      setLlmOverride(admin, seasonId, {
        enabled: true,
        models: ['small'],
        official: { token_budget: 10_000, rate_limit_rpm: 60 },
        development: { token_budget: 10_000, rate_limit_rpm: 60 },
      }),
  })
})

test('spades Partnership Cup: both example agents, partial ratings, released', async ({
  admin,
  as,
}) => {
  test.skip(!seedDemo, SEED_SKIP_REASON)
  test.setTimeout(900_000)

  const staged = new Map<string, string>()
  for (const agent of ['counter', 'signaler'] as const) {
    staged.set(agent, stageExampleAgent('spades', agent))
  }
  await seedReleasedSeason(admin, as, {
    envId: SPADES_ENV_ID,
    label: SPADES_SEASON,
    roster: [
      {
        owner: SPADES_OWNERS.counter,
        dir: staged.get('counter') as string,
        scores: [4, 4, 3, 4],
        raters: 2,
        seatCount: 2,
      },
      {
        owner: SPADES_OWNERS.signaler,
        dir: staged.get('signaler') as string,
        scores: [4, 3, 4, 3],
        raters: 2,
        seatCount: 2,
      },
    ],
    matches: [{ seats: ['submission', 'submission'], seeds: [0], games: 1 }],
  })
})

test('crane Reach Army: the example banner on the Season 5 preset, released', async ({
  admin,
  as,
}) => {
  test.skip(!seedDemo, SEED_SKIP_REASON)
  test.setTimeout(900_000)

  await seedReleasedSeason(admin, as, {
    envId: 'skirmish_crane',
    label: 'Crane Reach Army',
    roster: [
      {
        owner: CRANE_OWNERS.banner,
        dir: stageExampleAgent('skirmish_crane', 'banner'),
        scores: [4, 5],
        raters: 2,
        seatCount: 2,
      },
    ],
    matches: [{ seats: ['submission', 'builtin:naive'], seeds: [4], games: 1 }],
    // The same army-variant Season 5 preset the arc's editor configures, with the two length knobs
    // turned down so the seed does not pay for an hour-long battle.
    mergeConfig: (admin, seasonId) =>
      setSeasonOverrides(admin, seasonId, {
        parameters: {
          seat_plan: 'army',
          field_extent: 10,
          terrain: true,
          unit_abilities: true,
          capture_zones: 3,
          capture_target: 60,
          round_cap: 100,
        },
      }),
  })
})
