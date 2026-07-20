import { fireEvent, screen, waitFor } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdminSeasonView,
  Board,
  PublicSeasonView,
  RunView,
  SeasonView,
} from '../src/api/client.js'
import { flappyMeta } from './helpers/fixtures.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getEnvironments: vi.fn(),
  listSeasons: vi.fn(),
  getAdminSeason: vi.fn(),
  listRuns: vi.fn(),
  declareSeason: vi.fn(),
  renameSeason: vi.fn(),
  configureSeason: vi.fn(),
  setSeasonRatingPrompt: vi.fn(),
  openSubmissions: vi.fn(),
  closeSubmissions: vi.fn(),
  openPlay: vi.fn(),
  closePlay: vi.fn(),
  releaseSeason: vi.fn(),
  unreleaseSeason: vi.fn(),
  triggerRun: vi.fn(),
  cancelRun: vi.fn(),
  // The console's Submissions section mounts SeasonSubmissions, which lists submissions and builds
  // download URLs; stub them so the section renders without a real fetch.
  listSeasonSubmissions: vi.fn(() => Promise.resolve([])),
  adminSeasonDownloadUrl: vi.fn(() => '#'),
  adminSubmissionDownloadUrl: vi.fn(() => '#'),
  listAdminLlmDevelopmentUsers: vi.fn(async () => []),
  listAdminLlmDevelopmentCalls: vi.fn(async () => ({ calls: [], next_cursor: null })),
}))

import {
  configureSeason,
  declareSeason,
  getAdminSeason,
  getEnvironments,
  getMe,
  listAdminLlmDevelopmentCalls,
  listAdminLlmDevelopmentUsers,
  listRuns,
  listSeasons,
  openPlay,
  openSubmissions,
  releaseSeason,
  renameSeason,
  setSeasonRatingPrompt,
  triggerRun,
} from '../src/api/client.js'
import AdminConsolePage from '../src/pages/AdminConsolePage.vue'

function season(overrides: Partial<SeasonView> = {}): SeasonView {
  return {
    id: 'iter-1',
    env_id: 'flappy_bird',
    submission_status: 'closed',
    play_status: 'closed',
    release_status: 'unreleased',
    label: 'Week 1',
    config: { deps_version: 1, matches: [{ slots: ['submission'], seeds: [0], games: 1 }] },
    rating_prompt: null,
    created_at: '2026-06-10T00:00:00Z',
    released_at: null,
    ...overrides,
  }
}

/** The lighter picker shape the console now lists through `listSeasons` (with activity counts). */
function pickerSeason(overrides: Partial<SeasonView> = {}): PublicSeasonView {
  const { config: _config, rating_prompt: _ratingPrompt, ...rest } = season(overrides)
  return { ...rest, submission_count: 0, game_count: 0 }
}

function emptyBoard(): Board {
  return { automated: [], human: [], games: [] }
}

function adminView(overrides: Partial<AdminSeasonView> = {}): AdminSeasonView {
  return {
    season: season(),
    latest_run: null,
    board: emptyBoard(),
    ...overrides,
  }
}

function runningRun(): RunView {
  return {
    id: 'run-1',
    season_id: 'iter-1',
    requested_by: 'dev-user',
    config_snapshot: {
      deps_version: 1,
      matches: [{ slots: ['submission'], seeds: [0], games: 1 }],
    },
    submission_snapshot: [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }],
    status: 'running',
    started_at: '2026-06-12T00:00:00Z',
    ended_at: null,
    error: null,
    games: [
      {
        id: 'g1',
        run_id: 'run-1',
        match_index: 0,
        game_index: 0,
        seed: 0,
        slots: [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }],
        status: 'pending',
        recording_id: null,
        started_at: null,
        ended_at: null,
        error: null,
      },
    ],
  }
}

async function renderConsole() {
  const router = memoryRouter([
    { path: '/', component: { template: '<div />' } },
    { path: '/environments/:envId', component: { template: '<div />' } },
    { path: '/environments/:envId/agents/:ownerId', component: { template: '<div />' } },
    { path: '/environments/:envId/leaderboards/:seasonId?', component: { template: '<div />' } },
    { path: '/replays/:id', component: { template: '<div />' } },
    { path: '/environments/:envId/admin', component: AdminConsolePage },
    {
      path: '/environments/:envId/admin/seasons/:seasonId/runs/:runId',
      component: { template: '<div />' },
    },
  ])
  router.push('/environments/flappy_bird/admin')
  await router.isReady()
  return Object.assign(renderWithMe(router), { router })
}

describe('AdminConsolePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta()])
    vi.mocked(getMe).mockResolvedValue(signedInMe('dev-user', 'admin'))
    vi.mocked(listSeasons).mockResolvedValue([pickerSeason()])
    vi.mocked(getAdminSeason).mockResolvedValue(adminView())
    vi.mocked(listRuns).mockResolvedValue([])
    vi.mocked(listAdminLlmDevelopmentUsers).mockResolvedValue([])
    vi.mocked(listAdminLlmDevelopmentCalls).mockResolvedValue({ calls: [], next_cursor: null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders an access notice for a non-operator', async () => {
    vi.mocked(getMe).mockResolvedValue(signedInMe('carol', 'normal'))
    await renderConsole()
    expect(await screen.findByText(/limited to operators/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Declare season' })).toBeNull()
  })

  it('renders the console and the selected season for an operator', async () => {
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Season Management' })).toBeInTheDocument()
    expect(vi.mocked(getAdminSeason)).toHaveBeenCalledWith('iter-1')
    // The three independent gates each show their current state (await the detail load).
    expect(await screen.findByText('Unreleased')).toBeInTheDocument()
    expect(screen.getByText('Submissions closed')).toBeInTheDocument()
    expect(screen.getByText('Play closed')).toBeInTheDocument()
  })

  it('shows development totals and opens the shared history dialog from a participant row', async () => {
    vi.mocked(listAdminLlmDevelopmentUsers).mockResolvedValue([
      {
        user_id: 'alice',
        successful_calls: 3,
        usage_estimated: false,
        budget_cost_units_used: 250,
        budget_cost_units_remaining: 750,
      },
    ])
    vi.mocked(listAdminLlmDevelopmentCalls).mockResolvedValue({ calls: [], next_cursor: null })
    await renderConsole()

    expect(await screen.findByRole('heading', { name: 'Development usage' })).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('250 units')).toBeInTheDocument()
    expect(screen.getByText('750 units')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'alice' }))
    expect(vi.mocked(listAdminLlmDevelopmentCalls)).toHaveBeenCalledWith('iter-1', 'alice', {
      limit: 25,
    })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText(/latency/i)).toBeNull()
    expect(screen.queryByText(/estimate/i)).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('groups run configuration into three cards with the save action after them', async () => {
    await renderConsole()

    const runConfigurationHeading = await screen.findByRole('heading', {
      name: 'Run Configuration',
    })
    const runConfiguration = runConfigurationHeading.closest('section')
    expect(runConfiguration).not.toBeNull()
    expect(runConfiguration?.querySelectorAll('.ui-card')).toHaveLength(3)

    for (const title of ['Match Design', 'Session Behavior', 'LLM Access']) {
      expect(screen.getByRole('heading', { name: title }).closest('.ui-card')).not.toBeNull()
    }
    expect(screen.getByTestId('match')).toHaveClass('match')
    expect(screen.getByRole('group', { name: 'Per-slot limits' })).toHaveClass('limit-group')
    expect(screen.getByRole('group', { name: 'Development per-participant limits' })).toHaveClass(
      'limit-group',
    )
    expect(
      screen.getByRole('button', { name: 'Save configuration' }).closest('.ui-card'),
    ).toBeNull()

    const messaging = screen.getByLabelText('Messaging') as HTMLSelectElement
    expect(messaging).toHaveDisplayValue('Environment default (off)')
    expect(Array.from(messaging.options, (option) => [option.value, option.text])).toEqual([
      ['default', 'Environment default (off)'],
      ['off', 'Off'],
    ])
  })

  it('labels an enabled environment default and canonicalizes an explicit true override', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta({ messaging: true })])
    const explicitTrue = season({
      config: {
        deps_version: 1,
        matches: [{ slots: ['submission'], seeds: [0], games: 1 }],
        overrides: { messaging: { enabled: true } },
      },
    })
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ season: explicitTrue }))
    vi.mocked(configureSeason).mockResolvedValue({ ok: true, season: explicitTrue })
    await renderConsole()

    expect(await screen.findByLabelText('Messaging')).toHaveDisplayValue('Environment default (on)')
    expect(screen.getByRole('button', { name: 'Run workflow' })).toBeEnabled()
    await fireEvent.update(screen.getByLabelText('Step timeout (ms)'), '500')
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))

    await waitFor(() => expect(vi.mocked(configureSeason)).toHaveBeenCalled())
    const savedConfig = vi.mocked(configureSeason).mock.calls[0]?.[1]
    expect(savedConfig?.overrides?.step_timeout_ms).toBe(500)
    expect(savedConfig?.overrides?.messaging).toBeUndefined()
  })

  it('prefixes an unnamed season exactly once', async () => {
    const unnamed = season({ id: 'abcdef123456', label: null })
    vi.mocked(listSeasons).mockResolvedValue([pickerSeason({ id: 'abcdef123456', label: null })])
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ season: unnamed }))
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Season: abcdef12' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Season Season/ })).toBeNull()
  })

  it('declares a new season through the admin API', async () => {
    vi.mocked(declareSeason).mockResolvedValue(season({ id: 'iter-2', label: 'Week 2' }))
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Declare season' }))
    expect(vi.mocked(declareSeason)).toHaveBeenCalledWith('flappy_bird', {})
  })

  it('surfaces the one-open-submission invariant when opening submissions', async () => {
    vi.mocked(openSubmissions).mockResolvedValue({ ok: false, reason: 'open_season_exists' })
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Open submissions' }))
    expect(await screen.findByText(/already accepting submissions/)).toBeInTheDocument()
  })

  it('surfaces the one-play-open invariant when opening play on an unreleased season', async () => {
    vi.mocked(openPlay).mockResolvedValue({ ok: false, reason: 'open_play_season_exists' })
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Open play' }))
    expect(await screen.findByText(/already open for public play/)).toBeInTheDocument()
  })

  it('releases the season through the release endpoint', async () => {
    vi.mocked(releaseSeason).mockResolvedValue(season({ release_status: 'released' }))
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
    expect(vi.mocked(releaseSeason)).toHaveBeenCalledWith('iter-1')
  })

  it('renames the selected season through the admin API', async () => {
    vi.mocked(renameSeason).mockResolvedValue({
      ok: true,
      season: season({ label: 'Playground' }),
    })
    // The reload after a successful rename reads back the renamed season.
    vi.mocked(getAdminSeason).mockResolvedValue(
      adminView({ season: season({ label: 'Playground' }) }),
    )
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Rename' }))
    await fireEvent.update(await screen.findByLabelText('Season name'), 'Playground')
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(vi.mocked(renameSeason)).toHaveBeenCalledWith('iter-1', 'Playground')
    // Rename mode closes and the new name shows, prefixed in the detail heading.
    expect(await screen.findByRole('heading', { name: 'Season Playground' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument()
  })

  it('refuses to save a match with zero slots', async () => {
    await renderConsole()
    // Remove the match's only slot, then attempt to save.
    await fireEvent.click(await screen.findByRole('button', { name: '×' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
    expect(await screen.findByText(/has no slots/)).toBeInTheDocument()
    expect(vi.mocked(configureSeason)).not.toHaveBeenCalled()
  })

  it('prompts the force confirmation when runs exist and re-sends with force', async () => {
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ latest_run: runningRun() }))
    vi.mocked(configureSeason)
      .mockResolvedValueOnce({ ok: false, reason: 'season_has_runs', message: 'has runs' })
      .mockResolvedValueOnce({ ok: true, season: season() })
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Save configuration' }))
    // The dialog spells out the deletion before sending force.
    expect(await screen.findByText(/deletes its existing runs and boards/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Delete and save' }))

    await waitFor(() => expect(vi.mocked(configureSeason)).toHaveBeenCalledTimes(2))
    expect(vi.mocked(configureSeason).mock.calls[1]?.[2]).toBe(true)
  })

  it('warns that a forced dependency change also deletes submissions when runs exist', async () => {
    vi.mocked(configureSeason).mockResolvedValue({
      ok: false,
      reason: 'season_has_runs',
      message: 'has runs',
    })
    await renderConsole()

    await fireEvent.update(await screen.findByLabelText('Dependency-set version'), '2')
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))

    expect(await screen.findByText(/deletes this season's submissions/)).toBeInTheDocument()
    expect(screen.getByText(/along with its existing runs and boards/)).toBeInTheDocument()
  })

  it('writes the visible LLM access and limit controls while preserving stored prices', async () => {
    const withLlm = season({
      config: {
        deps_version: 1,
        matches: [{ slots: ['submission'], seeds: [0], games: 1 }],
        overrides: { llm: { enabled: false, cost_weights: { medium: 2.5 } } },
      },
    })
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ season: withLlm }))
    vi.mocked(configureSeason).mockResolvedValue({ ok: true, season: withLlm })
    await renderConsole()

    await fireEvent.update(await screen.findByLabelText('LLM enablement'), 'on')
    await fireEvent.update(screen.getByLabelText('Allowed model aliases'), 'custom')
    await fireEvent.click(screen.getByLabelText('small'))
    await fireEvent.click(screen.getByLabelText('medium'))
    await fireEvent.update(screen.getByLabelText('Per-slot token budget'), '10000')
    await fireEvent.update(screen.getByLabelText('Per-slot rate limit (RPM)'), '30')
    await fireEvent.update(screen.getByLabelText('Development token budget'), '20000')
    await fireEvent.update(screen.getByLabelText('Development rate limit (RPM)'), '15')
    await fireEvent.click(await screen.findByRole('button', { name: 'Save configuration' }))

    await waitFor(() => expect(vi.mocked(configureSeason)).toHaveBeenCalled())
    const savedConfig = vi.mocked(configureSeason).mock.calls[0]?.[1]
    expect(savedConfig?.overrides?.llm).toEqual({
      enabled: true,
      models: ['medium', 'small'],
      cost_weights: { medium: 2.5 },
      official: { token_budget: 10_000, rate_limit_rpm: 30 },
      development: { token_budget: 20_000, rate_limit_rpm: 15 },
    })
  })

  it('rejects a custom LLM model list with no aliases', async () => {
    await renderConsole()
    await fireEvent.update(await screen.findByLabelText('Allowed model aliases'), 'custom')
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))

    expect(
      await screen.findByText(/Select at least one allowed LLM model alias/),
    ).toBeInTheDocument()
    expect(vi.mocked(configureSeason)).not.toHaveBeenCalled()
  })

  it('rejects non-positive LLM limits before saving', async () => {
    await renderConsole()
    await fireEvent.update(await screen.findByLabelText('Development token budget'), '0')
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))

    expect(
      await screen.findByText(/development token budget must be a positive integer/),
    ).toBeInTheDocument()
    expect(vi.mocked(configureSeason)).not.toHaveBeenCalled()
  })

  it('rejects an invalid stored model token price before saving', async () => {
    vi.mocked(getAdminSeason).mockResolvedValue(
      adminView({
        season: season({
          config: {
            deps_version: 1,
            matches: [{ slots: ['submission'], seeds: [0], games: 1 }],
            overrides: { llm: { cost_weights: { large: 1_000_001 } } },
          },
        }),
      }),
    )
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Save configuration' }))

    expect(
      await screen.findByText(/large model token price must be a positive finite number/),
    ).toBeInTheDocument()
    expect(vi.mocked(configureSeason)).not.toHaveBeenCalled()
  })

  it('discards a stale detail response after the operator selects another season', async () => {
    const second = season({ id: 'iter-2', label: 'Week 2' })
    vi.mocked(listSeasons).mockResolvedValue([
      pickerSeason(),
      pickerSeason({ id: 'iter-2', label: 'Week 2' }),
    ])
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()

    let resolveWeek1: ((value: AdminSeasonView) => void) | undefined
    let resolveWeek2: ((value: AdminSeasonView) => void) | undefined
    vi.mocked(getAdminSeason).mockImplementation((id) => {
      return new Promise((resolve) => {
        if (id === 'iter-2') {
          resolveWeek2 = resolve
        } else {
          resolveWeek1 = resolve
        }
      })
    })

    await fireEvent.click(screen.getByRole('button', { name: /Week 2/ }))
    await fireEvent.click(screen.getByRole('button', { name: /Week 1/ }))
    resolveWeek1?.(adminView())
    expect(await screen.findByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()

    resolveWeek2?.(adminView({ season: second }))
    await Promise.resolve()
    expect(screen.queryByRole('heading', { name: 'Season Week 2' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()
  })

  it('saves the season rating prompt and stays editable after a run', async () => {
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ latest_run: runningRun() }))
    vi.mocked(setSeasonRatingPrompt).mockResolvedValue({
      ok: true,
      season: season({ rating_prompt: 'Judge smoothness' }),
    })
    await renderConsole()

    const textarea = await screen.findByLabelText('Rating prompt')
    await fireEvent.update(textarea, 'Judge smoothness')
    await fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }))
    expect(vi.mocked(setSeasonRatingPrompt)).toHaveBeenCalledWith('iter-1', 'Judge smoothness')
    expect(await screen.findByText('Saved ✓')).toBeInTheDocument()
  })

  it('surfaces run_in_progress and empty_schedule from a trigger', async () => {
    vi.mocked(triggerRun).mockResolvedValue({
      ok: false,
      reason: 'run_in_progress',
      message: 'busy',
    })
    await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Run workflow' }))
    expect(await screen.findByText(/already in progress/)).toBeInTheDocument()

    vi.mocked(triggerRun).mockResolvedValue({
      ok: false,
      reason: 'empty_schedule',
      message: 'empty',
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }))
    expect(await screen.findByText(/match design/)).toBeInTheDocument()
  })

  it('disables Run workflow while the match design has unsaved edits', async () => {
    await renderConsole()
    // The seeded config matches the persisted season, so the run trigger starts available.
    expect(await screen.findByRole('button', { name: 'Run workflow' })).toBeEnabled()

    // Add a match without saving: the design now differs from the persisted config.
    await fireEvent.click(screen.getByRole('button', { name: 'Add match' }))

    expect(screen.getByRole('button', { name: 'Run workflow' })).toBeDisabled()
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()
    expect(screen.getByText(/Save the match design before running/)).toBeInTheDocument()
  })

  it('navigates to the new run details page after a trigger', async () => {
    // The console hands off to the run-details page (which owns the live stream) on a successful run.
    vi.mocked(triggerRun).mockResolvedValue({ ok: true, id: 'run-1', status: 'pending' })

    const { router } = await renderConsole()
    await fireEvent.click(await screen.findByRole('button', { name: 'Run workflow' }))

    await waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe(
        '/environments/flappy_bird/admin/seasons/iter-1/runs/run-1',
      ),
    )
  })

  it('places the run actions above Run Configuration and lists past runs at the end', async () => {
    vi.mocked(listRuns).mockResolvedValue([
      {
        id: 'run-1',
        season_id: 'iter-1',
        requested_by: 'dev-user',
        status: 'completed',
        started_at: '2026-06-12T00:00:00Z',
        ended_at: '2026-06-12T00:05:00Z',
        error: null,
        game_count: 4,
      },
    ])
    await renderConsole()

    const actions = await screen.findByRole('button', { name: 'Run workflow' })
    const config = screen.getByRole('heading', { name: 'Run Configuration' })
    // The action row precedes the Run Configuration section (DOCUMENT_POSITION_FOLLOWING = 4).
    expect(actions.compareDocumentPosition(config) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // The past run is listed and links to its details page.
    const link = screen.getByRole('link', { name: /2026/ })
    expect(link).toHaveAttribute(
      'href',
      '/environments/flappy_bird/admin/seasons/iter-1/runs/run-1',
    )
    // No requested_by_name on this summary, so the Requested by cell falls back to the stable id, kept
    // as its own tooltip.
    const requester = screen.getByText('dev-user')
    expect(requester).toHaveAttribute('title', 'dev-user')
  })

  it('prefers requested_by_name over the requester id in the runs list, keeping the id as a tooltip', async () => {
    vi.mocked(listRuns).mockResolvedValue([
      {
        id: 'run-1',
        season_id: 'iter-1',
        requested_by: 'dev-user',
        requested_by_name: 'Dev User',
        status: 'completed',
        started_at: '2026-06-12T00:00:00Z',
        ended_at: '2026-06-12T00:05:00Z',
        error: null,
        game_count: 4,
      },
    ])
    await renderConsole()

    const requester = await screen.findByText('Dev User')
    expect(requester).toHaveAttribute('title', 'dev-user')
    expect(screen.queryByText('dev-user', { exact: true })).toBeNull()
  })

  it('links to the season board once a run has computed one', async () => {
    const board: Board = {
      automated: [
        {
          agent: { kind: 'builtin-naive' },
          mean_score: 5,
          score_std: 0,
          mean_agent_compute_ms: 1,
          compute_std: 0,
          llm_usage_by_model: null,
          llm_weighted_cost: null,
          failure_count: 0,
          games: 2,
          recording_id: 'rec-1',
        },
      ],
      human: [],
      games: [],
    }
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ board }))
    await renderConsole()
    const link = await screen.findByRole('link', { name: 'Check leaderboard' })
    expect(link).toHaveAttribute('href', '/environments/flappy_bird/leaderboards/iter-1')
  })

  it('disables the board link before any run has computed a board', async () => {
    await renderConsole()
    expect(await screen.findByRole('button', { name: 'Check leaderboard' })).toBeDisabled()
  })
})
