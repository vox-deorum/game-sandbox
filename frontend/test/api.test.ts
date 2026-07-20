import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  adminSeasonDownloadUrl,
  adminSubmissionDownloadUrl,
  configureSeason,
  declareSeason,
  deleteSeason,
  getAuthorPrompt,
  getEnvironmentLeaderboards,
  getEnvironments,
  getLlmDevelopmentSummary,
  getMe,
  getMyAgents,
  getRecording,
  getRecordingLlm,
  getSeasonLeaderboards,
  getSessionRatings,
  getSiteConfig,
  listAdminLlmDevelopmentCalls,
  listAdminLlmDevelopmentUsers,
  listLlmDevelopmentCalls,
  listLlmDevelopmentSeasons,
  listSeasons,
  listWatchAgents,
  openSubmissions,
  pinRecording,
  rotateLlmDevelopmentKey,
  type SeasonConfig,
  setAuthorPrompt,
  startSession,
  submitRatings,
  triggerRun,
  unpinRecording,
} from '../src/api/client.js'
import { jsonResponse, stubFetch } from './helpers/fetchStub.js'
import { flappyMeta } from './helpers/fixtures.js'
import { anonymousMe, signedInMe } from './helpers/me.js'

const META = flappyMeta()

describe('api client', () => {
  // The one request choke point reads window.location on every call (for the 401 → /login bounce), and
  // jsdom's real location throws on assign. Replace it with a plain double, defaulting pathname to '/'
  // so the non-401 cases never touch the redirect branch.
  let assignSpy: ReturnType<typeof vi.fn>
  let originalLocation: Location
  beforeEach(() => {
    originalLocation = window.location
    assignSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        pathname: '/',
        origin: 'http://localhost',
        href: 'http://localhost/',
        assign: assignSpy,
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    })
  })

  it('returns validated environments and sends no identity header (same-origin cookie)', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([META]))
    const envs = await getEnvironments()
    expect(envs).toEqual([META])
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/environments')
    // Same-origin requests carry the Better Auth session cookie automatically, so the client sends no
    // custom identity header — this GET carries no headers at all.
    expect(init?.headers).toBeUndefined()
  })

  it('bounces to /login when a request 401s with code auth_required', async () => {
    stubFetch(async () => jsonResponse({ code: 'auth_required' }, 401))
    // The redirect fires from the request choke point; the wrapper still rejects afterwards. Either way
    // the assertion is on assignSpy, so swallow the throw.
    await expect(getEnvironments()).rejects.toBeInstanceOf(ApiError)
    expect(assignSpy).toHaveBeenCalledWith('/login')
  })

  it('does not bounce on a 401 auth_required when already on /login', async () => {
    window.location.pathname = '/login'
    stubFetch(async () => jsonResponse({ code: 'auth_required' }, 401))
    await expect(getEnvironments()).rejects.toBeInstanceOf(ApiError)
    expect(assignSpy).not.toHaveBeenCalled()
  })

  it('builds the operator download URLs from the session cookie, with no ?user= param', () => {
    expect(adminSubmissionDownloadUrl('sub-1')).toBe('/api/admin/submissions/sub-1/download')
    expect(adminSeasonDownloadUrl('iter-1')).toBe('/api/admin/seasons/iter-1/submissions/download')
  })

  it('throws ApiError when the environment list has the wrong shape', async () => {
    stubFetch(async () => jsonResponse([{ env_id: 'x' }]))
    await expect(getEnvironments()).rejects.toBeInstanceOf(ApiError)
  })

  it('returns the signed-in session user and status from /api/me', async () => {
    stubFetch(async () => jsonResponse(signedInMe('dev-user', 'admin')))
    expect(await getMe()).toEqual(signedInMe('dev-user', 'admin'))
  })

  it('returns { user: null } from /api/me for an anonymous visitor', async () => {
    stubFetch(async () => jsonResponse({ user: null }))
    expect(await getMe()).toEqual(anonymousMe)
  })

  it("reads the signed-in user's cross-environment season summaries without an owner parameter", async () => {
    const payload = [
      {
        env_id: 'flappy_bird',
        current_season: {
          id: 'iter-2',
          label: 'Week 2',
          created_at: '2026-06-15T00:00:00Z',
          release_status: 'unreleased',
          submission: {
            id: 'sub-2',
            status: 'pending',
            submitted_at: '2026-06-16T00:00:00Z',
          },
          mean_score: null,
        },
        previous_seasons: [],
      },
    ]
    const fetchMock = stubFetch(async () => jsonResponse(payload))

    expect(await getMyAgents()).toEqual(payload)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/my/agents')
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).toBeUndefined()
  })

  it('reads the deployment site name, short name, and github_auth flag from /api/config', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ site_name: 'Acme Arena', site_short_name: 'Acme', github_auth: true }),
    )
    expect(await getSiteConfig()).toEqual({
      site_name: 'Acme Arena',
      site_short_name: 'Acme',
      github_auth: true,
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/config')
  })

  it('maps a 201 to a started session', async () => {
    stubFetch(async () => jsonResponse({ id: 's1', ws_path: '/api/sessions/s1/ws' }, 201))
    expect(
      await startSession({ envId: 'flappy_bird', slots: { player_0: { kind: 'human' } } }),
    ).toEqual({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
  })

  it('maps a 403 to not_active', async () => {
    stubFetch(async () => jsonResponse({ error: 'no', code: 'not_active' }, 403))
    expect(
      await startSession({ envId: 'flappy_bird', slots: { player_0: { kind: 'human' } } }),
    ).toEqual({
      ok: false,
      reason: 'not_active',
    })
  })

  it('maps a 409 to already_active with the active session id', async () => {
    stubFetch(async () =>
      jsonResponse({ error: 'busy', code: 'already_active', active_session_id: 'abc' }, 409),
    )
    expect(
      await startSession({ envId: 'flappy_bird', slots: { player_0: { kind: 'human' } } }),
    ).toEqual({
      ok: false,
      reason: 'already_active',
      activeSessionId: 'abc',
    })
  })

  it('sends env_id, the slots assignment, and the human-slot timeout override in the body', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ id: 's1', ws_path: '/api/sessions/s1/ws' }, 201),
    )
    await startSession({
      envId: 'hearts',
      humanSlotTimeoutMs: 2000,
      slots: {
        player_0: { kind: 'human' },
        player_1: { kind: 'submission', submissionId: 'sub-1' },
        player_2: { kind: 'builtin-agent' },
        player_3: { kind: 'builtin-agent' },
      },
    })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(init.body as string)
    // The new start contract: an explicit per-slot `slots` object, snake-case `submission_id` only on
    // a `submission` slot, and no derived `mode` field (the backend derives it from the assignment).
    expect(body).toMatchObject({
      env_id: 'hearts',
      human_slot_timeout_ms: 2000,
      slots: {
        player_0: { kind: 'human' },
        player_1: { kind: 'submission', submission_id: 'sub-1' },
        player_2: { kind: 'builtin-agent' },
        player_3: { kind: 'builtin-agent' },
      },
    })
    expect(body).not.toHaveProperty('mode')
    expect(body).not.toHaveProperty('submission_id')
    expect(body.slots.player_1).not.toHaveProperty('submissionId')
  })

  it('fetches a recording as raw text', async () => {
    stubFetch(async () => new Response('header\nstate\n', { status: 200 }))
    expect(await getRecording('rec-1')).toBe('header\nstate\n')
  })

  it('keeps unavailable recording telemetry distinct from a successful empty payload', async () => {
    stubFetch(async () => jsonResponse({ code: 'telemetry_unavailable' }, 500))
    await expect(getRecordingLlm('broken recording')).resolves.toEqual({
      ok: false,
      reason: 'telemetry_unavailable',
    })

    vi.unstubAllGlobals()
    const fetchMock = stubFetch(async () => jsonResponse({ calls: [], total_budget_cost_units: 0 }))
    await expect(getRecordingLlm('empty recording')).resolves.toEqual({
      ok: true,
      telemetry: { calls: [], total_budget_cost_units: 0 },
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/recordings/empty%20recording/llm')
  })

  it('maps a 204 pin to success and a 409 pinned_quota to its typed reason', async () => {
    const ok = stubFetch(async () => new Response(null, { status: 204 }))
    expect(await pinRecording('rec-1')).toEqual({ ok: true })
    const [url, init] = ok.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/recordings/rec-1/pin')
    expect(init.method).toBe('POST')

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ error: 'full', code: 'pinned_quota' }, 409))
    expect(await pinRecording('rec-1')).toEqual({ ok: false, reason: 'pinned_quota' })
  })

  it('unpins with a DELETE', async () => {
    const mock = stubFetch(async () => new Response(null, { status: 204 }))
    expect(await unpinRecording('rec-1')).toEqual({ ok: true })
    expect((mock.mock.calls[0]?.[1] as RequestInit).method).toBe('DELETE')
  })

  it('reads a session rating view and maps the unrateable conflicts onto typed reasons', async () => {
    const view = {
      session_id: 's1',
      season_id: 'iter-1',
      read_only: false,
      season_prompt: null,
      agents: [],
    }
    stubFetch(async () => jsonResponse(view))
    expect(await getSessionRatings('s1')).toEqual({ ok: true, ratings: view })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ code: 'session_not_finished' }, 409))
    expect(await getSessionRatings('s1')).toEqual({ ok: false, reason: 'not_finished' })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ code: 'session_not_rateable' }, 409))
    expect(await getSessionRatings('s1')).toEqual({ ok: false, reason: 'not_rateable' })
  })

  it('reads the viewer-specific anonymous watch-agent list', async () => {
    const payload = [
      {
        submission_id: 'sub-1',
        anonymous_number: 1,
        rating_status: 'unrated',
      },
    ]
    const fetchMock = stubFetch(async () => jsonResponse(payload))
    expect(await listWatchAgents('flappy bird')).toEqual(payload)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/environments/flappy%20bird/watch-agents')
  })

  it('posts the ratings batch and maps a play-closed conflict', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({
        session_id: 's1',
        season_id: 'iter-1',
        read_only: false,
        season_prompt: null,
        agents: [],
      }),
    )
    const batch = [{ agent: { kind: 'builtin-naive' as const }, score: 4 }]
    expect((await submitRatings('s1', batch)).ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sessions/s1/ratings')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ ratings: batch })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ code: 'play_closed' }, 409))
    expect(await submitRatings('s1', batch)).toEqual({ ok: false, reason: 'play_closed' })
  })

  it('reads and sets the author prompt, mapping the no-agent refusal', async () => {
    stubFetch(async () => jsonResponse({ season_id: 'iter-1', prompt: 'Judge skill' }))
    expect(await getAuthorPrompt('iter-1')).toEqual({
      season_id: 'iter-1',
      prompt: 'Judge skill',
    })

    vi.unstubAllGlobals()
    const setMock = stubFetch(async () => jsonResponse({ season_id: 'iter-1', prompt: null }))
    expect(await setAuthorPrompt('iter-1', null)).toEqual({ ok: true, prompt: null })
    const [url, init] = setMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/seasons/iter-1/agent-rating-prompt')
    expect(init.method).toBe('PUT')

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ code: 'no_agent_in_season' }, 409))
    expect(await setAuthorPrompt('iter-1', 'x')).toEqual({
      ok: false,
      reason: 'no_agent_in_season',
    })
  })

  // --- Leaderboards and the admin console (Stage 6.7) ---------------------------------------

  it('reads the environment leaderboards with the separate submit and play targets', async () => {
    const payload = {
      current: null,
      submission_season_id: 'iter-sub',
      play_season_id: 'iter-play',
    }
    const fetchMock = stubFetch(async () => jsonResponse(payload))
    expect(await getEnvironmentLeaderboards('flappy_bird')).toEqual(payload)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/environments/flappy_bird/leaderboards')
  })

  it('reads the public season index with an optional encoded environment filter', async () => {
    const payload = [
      {
        id: 'iter-1',
        env_id: 'flappy bird',
        submission_status: 'closed',
        play_status: 'open',
        release_status: 'unreleased',
        label: 'Week 1',
        created_at: '2026-06-10T00:00:00Z',
        released_at: null,
        submission_count: 3,
        game_count: 12,
      },
    ]
    const fetchMock = stubFetch(async () => jsonResponse(payload))
    expect(await listSeasons('flappy bird')).toEqual(payload)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/seasons?envId=flappy+bird')
  })

  it('adds includeUnreleased=true for an operator season listing', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([]))
    await listSeasons('flappy_bird', { includeUnreleased: true })
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/seasons?envId=flappy_bird&includeUnreleased=true',
    )
  })

  it('maps a 404 season leaderboards read (unreleased) to undefined', async () => {
    stubFetch(async () => jsonResponse({ error: 'no such released season' }, 404))
    expect(await getSeasonLeaderboards('flappy_bird', 'iter-x')).toBeUndefined()
  })

  it('declares a season through the admin prefix', async () => {
    const season = { id: 'iter-new' }
    const fetchMock = stubFetch(async () => jsonResponse(season, 201))
    expect(await declareSeason('flappy_bird', { label: 'Week 2' })).toEqual(season)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/admin/environments/flappy_bird/seasons')
    expect(JSON.parse(init.body as string)).toEqual({ label: 'Week 2' })
  })

  it('deletes a season through the admin prefix and maps deletion outcomes', async () => {
    const successMock = stubFetch(async () => new Response(null, { status: 204 }))
    expect(await deleteSeason('iter-1')).toEqual({ ok: true })
    const [url, init] = successMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/admin/seasons/iter-1')
    expect(init.method).toBe('DELETE')

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({}, 404))
    expect(await deleteSeason('missing')).toEqual({ ok: false, reason: 'not_found' })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ code: 'season_not_empty' }, 409))
    expect(await deleteSeason('iter-1')).toEqual({ ok: false, reason: 'season_not_empty' })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ code: 'season_not_deletable' }, 409))
    expect(await deleteSeason('iter-1')).toEqual({ ok: false, reason: 'season_not_deletable' })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({}, 500))
    expect(await deleteSeason('iter-1')).toEqual({ ok: false, reason: 'failed' })
  })

  it('sends ?force=true on a forced config edit and maps the unforced conflict', async () => {
    const config: SeasonConfig = {
      deps_version: 1,
      matches: [{ slots: ['submission'], seeds: [0], games: 1 }],
    }
    const conflictMock = stubFetch(async () =>
      jsonResponse({ error: 'season has runs', code: 'season_has_runs' }, 409),
    )
    const unforced = await configureSeason('iter-1', config)
    expect(unforced).toEqual({
      ok: false,
      reason: 'season_has_runs',
      message: 'season has runs',
    })
    expect(conflictMock.mock.calls[0]?.[0]).toBe('/api/admin/seasons/iter-1/config')

    vi.unstubAllGlobals()
    const okMock = stubFetch(async () => jsonResponse({ id: 'iter-1' }))
    const forced = await configureSeason('iter-1', config, true)
    expect(forced.ok).toBe(true)
    expect(okMock.mock.calls[0]?.[0]).toBe('/api/admin/seasons/iter-1/config?force=true')
  })

  it('maps the open-submissions one-open invariant conflict', async () => {
    stubFetch(async () => jsonResponse({ code: 'open_season_exists' }, 409))
    expect(await openSubmissions('iter-1')).toEqual({
      ok: false,
      reason: 'open_season_exists',
    })
  })

  it('maps the trigger-run conflicts (run_in_progress, empty_schedule)', async () => {
    stubFetch(async () => jsonResponse({ error: 'busy', code: 'run_in_progress' }, 409))
    expect(await triggerRun('iter-1')).toEqual({
      ok: false,
      reason: 'run_in_progress',
      message: 'busy',
    })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ error: 'empty', code: 'empty_schedule' }, 409))
    expect(await triggerRun('iter-1')).toEqual({
      ok: false,
      reason: 'empty_schedule',
      message: 'empty',
    })

    vi.unstubAllGlobals()
    stubFetch(async () => jsonResponse({ id: 'run-1', status: 'pending' }, 201))
    expect(await triggerRun('iter-1')).toEqual({ ok: true, id: 'run-1', status: 'pending' })
  })

  it('wraps participant LLM development discovery, summary, calls, and key rotation', async () => {
    const discovery = [{ season_id: 'season one', environment: 'hearts' }]
    const discoveryMock = stubFetch(async () => jsonResponse(discovery))
    expect(await listLlmDevelopmentSeasons()).toEqual(discovery)
    expect(discoveryMock.mock.calls[0]?.[0]).toBe('/api/llm-development/seasons')

    vi.unstubAllGlobals()
    const summary = { season_id: 'season one', successful_calls: 2 }
    const summaryMock = stubFetch(async () => jsonResponse(summary))
    expect(await getLlmDevelopmentSummary('season one')).toEqual(summary)
    expect(summaryMock.mock.calls[0]?.[0]).toBe('/api/seasons/season%20one/llm-development')

    vi.unstubAllGlobals()
    const page = { calls: [], next_cursor: 17 }
    const callsMock = stubFetch(async () => jsonResponse(page))
    expect(await listLlmDevelopmentCalls('season one', { cursor: 42, limit: 10 })).toEqual(page)
    expect(callsMock.mock.calls[0]?.[0]).toBe(
      '/api/seasons/season%20one/llm-development/calls?cursor=42&limit=10',
    )

    vi.unstubAllGlobals()
    const credential = { season_id: 'season one', base_url: 'https://example.test/api/llm/v1' }
    const rotateMock = stubFetch(async () => jsonResponse(credential))
    expect(await rotateLlmDevelopmentKey('season one')).toEqual(credential)
    expect(rotateMock.mock.calls[0]?.[0]).toBe('/api/seasons/season%20one/llm-development-key')
    expect((rotateMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST')
  })

  it('wraps operator LLM participant totals and encoded call history pagination', async () => {
    const users = [{ user_id: 'user/name', successful_calls: 1 }]
    const usersMock = stubFetch(async () => jsonResponse(users))
    expect(await listAdminLlmDevelopmentUsers('season one')).toEqual(users)
    expect(usersMock.mock.calls[0]?.[0]).toBe('/api/admin/seasons/season%20one/llm-development')

    vi.unstubAllGlobals()
    const page = { calls: [], next_cursor: null }
    const callsMock = stubFetch(async () => jsonResponse(page))
    expect(await listAdminLlmDevelopmentCalls('season one', 'user/name', { limit: 100 })).toEqual(
      page,
    )
    expect(callsMock.mock.calls[0]?.[0]).toBe(
      '/api/admin/seasons/season%20one/llm-development/users/user%2Fname/calls?limit=100',
    )
  })
})
