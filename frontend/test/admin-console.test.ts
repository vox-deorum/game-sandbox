import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { SEASON_DESCRIPTION_MAX } from '@game-sandbox/schema/seasons'
import { fireEvent, screen, waitFor, within } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AdminSeasonView,
  Board,
  PublicSeasonView,
  RunView,
  SeasonView,
} from '../src/api/client.js'
import { flappyMeta, spadesMeta } from './helpers/fixtures.js'
import { signedInMe } from './helpers/me.js'
import { memoryRouter, renderWithMe } from './helpers/render.js'

vi.mock('../src/api/client.js', () => ({
  getMe: vi.fn(),
  getEnvironments: vi.fn(),
  listSeasons: vi.fn(),
  getAdminSeason: vi.fn(),
  listRuns: vi.fn(),
  declareSeason: vi.fn(),
  deleteSeason: vi.fn(),
  renameSeason: vi.fn(),
  configureSeason: vi.fn(),
  setSeasonRatingPrompt: vi.fn(),
  setSeasonDescription: vi.fn(),
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
  deleteSeason,
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
  setSeasonDescription,
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
    config: { deps_version: 1, matches: [{ seats: ['submission'], seeds: [0], games: 1 }] },
    rating_prompt: null,
    description_markdown: null,
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
    eligible_submission_count: 0,
    latest_run: null,
    board: emptyBoard(),
    ...overrides,
  }
}

function configurableMeta(): EnvironmentMeta {
  return flappyMeta({
    parameters: [
      {
        name: 'players',
        title: 'Players',
        description: 'Players.',
        type: 'int',
        default: 1,
        min: 1,
        max: 1,
      },
      {
        name: 'pipe_gap',
        title: 'Pipe gap',
        description: 'Opening.',
        type: 'int',
        default: 100,
        min: 60,
        max: 200,
      },
      { name: 'tag', title: 'Tag', description: 'Optional label.', type: 'string', default: '' },
      {
        name: 'extras',
        title: 'Extras',
        description: 'Optional rules.',
        type: 'multi_choice',
        default: [],
        choices: [
          { value: 'wind', label: 'Wind' },
          { value: 'night', label: 'Night' },
        ],
      },
    ],
  })
}

function runningRun(): RunView {
  return {
    id: 'run-1',
    season_id: 'iter-1',
    requested_by: 'dev-user',
    config_snapshot: {
      deps_version: 1,
      matches: [{ seats: ['submission'], seeds: [0], games: 1 }],
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
        seats: [{ kind: 'submission', submission_id: 's1', user_id: 'alice' }],
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

  it('projects the advisory roster snapshot and explains a stale layout', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([spadesMeta({ env_id: 'flappy_bird' })])
    const configured = season({
      config: {
        deps_version: 1,
        matches: [{ seats: ['submission', 'submission'], seeds: [0], games: 2 }],
        overrides: { parameters: { seat_plan: 'partnership' } },
      },
    })
    vi.mocked(getAdminSeason).mockResolvedValue(
      adminView({ season: configured, eligible_submission_count: 20 }),
    )
    await renderConsole()

    expect(await screen.findByText('Projected games: 762')).toBeInTheDocument()
    expect(screen.getByText('Resolved layout: 2 seats.')).toBeInTheDocument()
    expect(screen.getByTestId('match-projection')).toHaveTextContent(
      '380 submitted assignments and 1 all-Naive assignment',
    )
    expect(screen.getByText(/20 eligible submissions as of page load/)).toBeInTheDocument()

    await fireEvent.update(screen.getByLabelText('Seat plan override'), 'solo')
    expect(screen.queryByText(/Projected games:/)).toBeNull()
    expect(screen.getByTestId('projection-error')).toHaveTextContent(
      'Match 1 has 2 seats, but the resolved layout has 4',
    )

    const match = screen.getByTestId('match')
    const addSeat = within(match).getByRole('button', { name: 'Add seat' })
    await fireEvent.click(addSeat)
    await fireEvent.click(addSeat)
    expect(screen.getByText('Projected games: 232,562')).toBeInTheDocument()
    expect(screen.queryByTestId('projection-error')).toBeNull()

    await fireEvent.update(within(match).getByRole('spinbutton', { name: 'Games' }), '0')
    expect(screen.queryByText(/Projected games:/)).toBeNull()
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
    expect(runConfiguration?.querySelectorAll('.ui-card')).toHaveLength(4)

    for (const title of [
      'Match Design',
      'Session Behavior',
      'LLM Access',
      'Environment Parameters',
    ]) {
      expect(screen.getByRole('heading', { name: title }).closest('.ui-card')).not.toBeNull()
    }
    expect(screen.getByTestId('match')).toHaveClass('match')
    expect(screen.getByRole('group', { name: 'Per-player limits' })).toHaveClass('limit-group')
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

  it('re-seeds parameter overrides when environment metadata arrives asynchronously', async () => {
    let resolveMeta: ((value: EnvironmentMeta[]) => void) | undefined
    vi.mocked(getEnvironments).mockReturnValue(
      new Promise((resolve) => {
        resolveMeta = resolve
      }),
    )
    const configured = season({
      config: {
        deps_version: 1,
        matches: [{ seats: ['submission'], seeds: [0], games: 1 }],
        overrides: { parameters: { pipe_gap: 90, obsolete: true } },
      },
    })
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ season: configured }))
    vi.mocked(configureSeason).mockResolvedValue({ ok: true, season: configured })
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Environment Parameters' })).toBeNull()

    resolveMeta?.([configurableMeta()])
    expect(
      await screen.findByRole('heading', { name: 'Environment Parameters' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Pipe gap')).toHaveDisplayValue('Override')
    expect(screen.getByLabelText('Pipe gap override')).toHaveValue(90)
    expect(
      screen.getByText(/Every match's seat count must match the resolved layout/),
    ).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
    await waitFor(() => expect(vi.mocked(configureSeason)).toHaveBeenCalled())
    expect(vi.mocked(configureSeason).mock.calls[0]?.[1].overrides?.parameters).toEqual({
      pipe_gap: 90,
    })
  })

  it('keeps edits made while the environment metadata request was still in flight', async () => {
    let resolveMeta: ((value: EnvironmentMeta[]) => void) | undefined
    vi.mocked(getEnvironments).mockReturnValue(
      new Promise((resolve) => {
        resolveMeta = resolve
      }),
    )
    await renderConsole()
    expect(await screen.findByRole('heading', { name: 'Season Week 1' })).toBeInTheDocument()

    // The season form is usable before the environment metadata lands, so an operator can already be
    // typing. The metadata only decides which parameter rows exist; it must not reach back and reset
    // the match, timeout, messaging, and LLM fields that have nothing to do with parameters.
    await fireEvent.update(screen.getByLabelText('Messaging'), 'off')
    await fireEvent.update(screen.getByLabelText('Step timeout (ms)'), '4321')

    resolveMeta?.([configurableMeta()])
    expect(
      await screen.findByRole('heading', { name: 'Environment Parameters' }),
    ).toBeInTheDocument()

    expect(screen.getByLabelText('Messaging')).toHaveValue('off')
    expect(screen.getByLabelText('Step timeout (ms)')).toHaveValue(4321)
  })

  it('shows a blank numeric override error and refuses to save it', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([configurableMeta()])
    await renderConsole()
    await fireEvent.update(await screen.findByLabelText('Pipe gap'), 'override')
    await fireEvent.update(screen.getByLabelText('Pipe gap override'), '')
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
    expect(vi.mocked(configureSeason)).not.toHaveBeenCalled()
  })

  it('preserves empty strings, normalizes multi-choice order, and excludes unknown stored keys', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([configurableMeta()])
    const configured = season({
      config: {
        deps_version: 1,
        matches: [{ seats: ['submission'], seeds: [0], games: 1 }],
        overrides: {
          parameters: { tag: '', extras: ['night', 'wind'], obsolete: 'drop me' },
        },
      },
    })
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ season: configured }))
    vi.mocked(configureSeason).mockResolvedValue({ ok: true, season: configured })
    await renderConsole()

    expect(await screen.findByLabelText('Tag')).toHaveDisplayValue('Override')
    expect(screen.getByLabelText('Tag override')).toHaveValue('')
    expect(screen.getByLabelText('Wind')).toBeChecked()
    expect(screen.getByLabelText('Night')).toBeChecked()
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
    await waitFor(() => expect(vi.mocked(configureSeason)).toHaveBeenCalled())
    expect(vi.mocked(configureSeason).mock.calls[0]?.[1].overrides?.parameters).toEqual({
      tag: '',
      extras: ['wind', 'night'],
    })
  })

  it('labels an enabled environment default and canonicalizes an explicit true override', async () => {
    vi.mocked(getEnvironments).mockResolvedValue([flappyMeta({ messaging: true })])
    const explicitTrue = season({
      config: {
        deps_version: 1,
        matches: [{ seats: ['submission'], seeds: [0], games: 1 }],
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

  it('opens deletion confirmation without sending a request and cancels cleanly', async () => {
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Delete season' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/Permanently delete Week 1/)).toBeInTheDocument()
    expect(screen.getByText(/Only closed, unreleased seasons without activity/)).toBeInTheDocument()
    expect(vi.mocked(deleteSeason)).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(vi.mocked(deleteSeason)).not.toHaveBeenCalled()
  })

  it('deletes a selected season, refreshes the list, and clears stale detail state', async () => {
    const replacement = season({ id: 'iter-2', label: 'Week 2' })
    vi.mocked(listSeasons)
      .mockResolvedValueOnce([pickerSeason()])
      .mockResolvedValueOnce([pickerSeason({ id: 'iter-2', label: 'Week 2' })])
    vi.mocked(getAdminSeason)
      .mockResolvedValueOnce(adminView())
      .mockResolvedValueOnce(adminView({ season: replacement }))
    vi.mocked(deleteSeason).mockResolvedValue({ ok: true })
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Delete season' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Delete season' }))

    await waitFor(() => expect(vi.mocked(deleteSeason)).toHaveBeenCalledWith('iter-1'))
    expect(await screen.findByRole('heading', { name: 'Season Week 2' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Season Week 1' })).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(vi.mocked(listSeasons)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(getAdminSeason)).toHaveBeenLastCalledWith('iter-2')
  })

  it('clears selected detail state when deleting the final season', async () => {
    vi.mocked(listSeasons).mockResolvedValueOnce([pickerSeason()]).mockResolvedValueOnce([])
    vi.mocked(deleteSeason).mockResolvedValue({ ok: true })
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Delete season' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Delete season' }))

    expect(
      await screen.findByText('Select or declare a season to configure it.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Season Week 1' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Run Configuration' })).toBeNull()
  })

  it('keeps deletion confirmation open with a useful conflict message', async () => {
    vi.mocked(deleteSeason).mockResolvedValue({ ok: false, reason: 'season_not_empty' })
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Delete season' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Delete season' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This season has activity, so it cannot be deleted.',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('keeps deletion confirmation open when deletion fails', async () => {
    vi.mocked(deleteSeason).mockResolvedValue({ ok: false, reason: 'failed' })
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Delete season' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Delete season' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not delete the season. Try again.',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
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

  it('refuses to save a match with zero seats', async () => {
    await renderConsole()
    // Remove the match's only seat, then attempt to save.
    await fireEvent.click(await screen.findByRole('button', { name: '×' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }))
    expect(await screen.findByText(/has no seats/)).toBeInTheDocument()
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
        matches: [{ seats: ['submission'], seeds: [0], games: 1 }],
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
    await fireEvent.update(screen.getByLabelText('Per-player token budget'), '10000')
    await fireEvent.update(screen.getByLabelText('Per-player rate limit (RPM)'), '30')
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
            matches: [{ seats: ['submission'], seeds: [0], games: 1 }],
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

  it('ignores a delayed rating prompt save for a previously selected season', async () => {
    vi.mocked(listSeasons).mockResolvedValue([
      pickerSeason({ rating_prompt: 'First prompt.' }),
      pickerSeason({ id: 'iter-2', label: 'Week 2', rating_prompt: 'Second prompt.' }),
    ])
    vi.mocked(getAdminSeason).mockImplementation(async (id) =>
      adminView({
        season: season({
          id,
          label: id === 'iter-2' ? 'Week 2' : 'Week 1',
          rating_prompt: id === 'iter-2' ? 'Second prompt.' : 'First prompt.',
        }),
      }),
    )
    let finish: ((value: { ok: true; season: SeasonView }) => void) | undefined
    vi.mocked(setSeasonRatingPrompt).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Save prompt' }))
    expect(screen.getByLabelText('Rating prompt')).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: /Week 2/ }))
    expect(await screen.findByLabelText('Rating prompt')).toHaveValue('Second prompt.')
    finish?.({ ok: true, season: season({ rating_prompt: 'Stale prompt.' }) })
    await Promise.resolve()
    expect(screen.getByLabelText('Rating prompt')).toHaveValue('Second prompt.')
    expect(screen.queryByText('Saved ✓')).toBeNull()
  })

  it('saves and clears the public season description after a run', async () => {
    vi.mocked(getAdminSeason).mockResolvedValue(adminView({ latest_run: runningRun() }))
    vi.mocked(setSeasonDescription).mockResolvedValue({
      ok: true,
      season: season({ description_markdown: 'Practice **timing**.' }),
    })
    await renderConsole()

    const textarea = await screen.findByLabelText('Season description')
    expect(
      screen.getByText(/After line-ending normalization, use up to 2,000 characters/),
    ).toBeInTheDocument()
    expect(textarea).toHaveAttribute('maxlength', String(SEASON_DESCRIPTION_MAX))
    await fireEvent.update(textarea, 'Practice **timing**.')
    await fireEvent.click(screen.getByRole('button', { name: 'Save description' }))
    expect(vi.mocked(setSeasonDescription)).toHaveBeenCalledWith('iter-1', 'Practice **timing**.')
    expect(await screen.findByRole('status')).toHaveTextContent('Saved')

    await fireEvent.click(screen.getByRole('button', { name: 'Clear description' }))
    expect(vi.mocked(setSeasonDescription)).toHaveBeenLastCalledWith('iter-1', null)
    expect(await screen.findByRole('status')).toHaveTextContent('Cleared')
  })

  it('reseeds the description draft from the normalized saved value', async () => {
    vi.mocked(setSeasonDescription).mockResolvedValue({
      ok: true,
      season: season({ description_markdown: 'Practice\ntiming.' }),
    })
    await renderConsole()

    const textarea = await screen.findByLabelText('Season description')
    await fireEvent.update(textarea, 'Practice\r\ntiming.')
    await fireEvent.click(screen.getByRole('button', { name: 'Save description' }))

    expect(await screen.findByLabelText('Season description')).toHaveValue('Practice\ntiming.')
  })

  it('keeps the description draft after a failed clear and uses a generic invalid request error', async () => {
    vi.mocked(getAdminSeason).mockResolvedValue(
      adminView({ season: season({ description_markdown: 'Keep this description.' }) }),
    )
    vi.mocked(setSeasonDescription).mockResolvedValueOnce({ ok: false, reason: 'failed' })
    vi.mocked(setSeasonDescription).mockResolvedValueOnce({ ok: false, reason: 'invalid' })
    await renderConsole()

    const textarea = await screen.findByLabelText('Season description')
    await fireEvent.click(screen.getByRole('button', { name: 'Clear description' }))
    expect(textarea).toHaveValue('Keep this description.')
    expect(
      await screen.findByText('Could not save the season description. Please try again.'),
    ).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('button', { name: 'Save description' }))
    expect(
      await screen.findByText('Could not save the season description. Please try again.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Use valid inline Markdown only.')).toBeNull()
  })

  it('shows typed description errors and reseeds when selection changes', async () => {
    vi.mocked(setSeasonDescription).mockResolvedValue({ ok: false, reason: 'multiple_paragraphs' })
    vi.mocked(listSeasons).mockResolvedValue([
      pickerSeason({ description_markdown: 'First summary.' }),
      pickerSeason({ id: 'iter-2', label: 'Week 2', description_markdown: 'Second summary.' }),
    ])
    vi.mocked(getAdminSeason).mockImplementation(async (id) =>
      adminView({
        season: season({
          id,
          label: id === 'iter-2' ? 'Week 2' : 'Week 1',
          description_markdown: id === 'iter-2' ? 'Second summary.' : 'First summary.',
        }),
      }),
    )
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Save description' }))
    expect(await screen.findByText('Use one paragraph only.')).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: /Week 2/ }))
    expect(await screen.findByLabelText('Season description')).toHaveValue('Second summary.')
  })

  it('ignores a delayed description save for a previously selected season', async () => {
    vi.mocked(listSeasons).mockResolvedValue([
      pickerSeason(),
      pickerSeason({ id: 'iter-2', label: 'Week 2', description_markdown: 'Second summary.' }),
    ])
    vi.mocked(getAdminSeason).mockImplementation(async (id) =>
      adminView({
        season: season({
          id,
          label: id === 'iter-2' ? 'Week 2' : 'Week 1',
          description_markdown: id === 'iter-2' ? 'Second summary.' : null,
        }),
      }),
    )
    let finish: ((value: { ok: true; season: SeasonView }) => void) | undefined
    vi.mocked(setSeasonDescription).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await renderConsole()

    await fireEvent.click(await screen.findByRole('button', { name: 'Save description' }))
    expect(screen.getByLabelText('Season description')).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: /Week 2/ }))
    expect(await screen.findByLabelText('Season description')).toHaveValue('Second summary.')
    finish?.({ ok: true, season: season({ description_markdown: 'Stale summary.' }) })
    await Promise.resolve()
    expect(screen.getByLabelText('Season description')).toHaveValue('Second summary.')
    expect(screen.queryByText('Saved')).toBeNull()
    expect(vi.mocked(listSeasons)).toHaveBeenCalledTimes(1)
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

  it('prompts before running while the configuration has unsaved edits', async () => {
    vi.mocked(triggerRun).mockResolvedValue({ ok: true, id: 'run-1', status: 'pending' })
    await renderConsole()
    // The seeded config matches the persisted season, so the run trigger starts available.
    expect(await screen.findByRole('button', { name: 'Run workflow' })).toBeEnabled()

    // Add a match without saving: the design now differs from the persisted config.
    await fireEvent.click(screen.getByRole('button', { name: 'Add match' }))

    expect(screen.getByRole('button', { name: 'Run workflow' })).toBeEnabled()
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()

    // The trigger asks first, and cancelling leaves the run unstarted.
    await fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }))
    expect(await screen.findByText(/those edits will not apply/)).toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(vi.mocked(triggerRun)).not.toHaveBeenCalled()

    // Confirming runs the persisted configuration.
    await fireEvent.click(screen.getByRole('button', { name: 'Run workflow' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Run anyway' }))
    await waitFor(() => expect(vi.mocked(triggerRun)).toHaveBeenCalledWith('iter-1'))
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

  it('places the run actions after Save configuration and lists past runs at the end', async () => {
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

    const save = await screen.findByRole('button', { name: 'Save configuration' })
    const trigger = screen.getByRole('button', { name: 'Run workflow' })
    const board = screen.getByRole('button', { name: 'Check leaderboard' })
    // The run controls close the Run Configuration section, after its save button
    // (DOCUMENT_POSITION_FOLLOWING = 4).
    expect(save.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(trigger.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(trigger.closest('section')).toBe(
      screen.getByRole('heading', { name: 'Run Configuration' }).closest('section'),
    )

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
