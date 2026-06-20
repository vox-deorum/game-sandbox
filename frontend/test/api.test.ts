import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  configureSeason,
  declareSeason,
  getAuthorPrompt,
  getEnvironmentLeaderboards,
  getEnvironments,
  getMe,
  getRecording,
  getSeasonLeaderboards,
  getSessionRatings,
  listPublicSeasons,
  openSubmissions,
  pinRecording,
  type SeasonConfig,
  setAuthorPrompt,
  startSession,
  submitRatings,
  triggerRun,
  unpinRecording,
} from '../src/api/client.js'
import { jsonResponse, stubFetch } from './helpers/fetchStub.js'
import { flappyMeta } from './helpers/fixtures.js'

const META = flappyMeta()

describe('api client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns validated environments and carries the identity header', async () => {
    const fetchMock = stubFetch(async () => jsonResponse([META]))
    const envs = await getEnvironments()
    expect(envs).toEqual([META])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/environments')
    expect((init.headers as Record<string, string>)['x-sandbox-user']).toBe('dev-user')
  })

  it('throws ApiError when the environment list has the wrong shape', async () => {
    stubFetch(async () => jsonResponse([{ env_id: 'x' }]))
    await expect(getEnvironments()).rejects.toBeInstanceOf(ApiError)
  })

  it('reports identity, allowlist membership, and operator status from /api/me', async () => {
    stubFetch(async () =>
      jsonResponse({ user_id: 'dev-user', allowlisted: true, is_operator: true }),
    )
    expect(await getMe()).toEqual({ user_id: 'dev-user', allowlisted: true, is_operator: true })
  })

  it('maps a 201 to a started session', async () => {
    stubFetch(async () => jsonResponse({ id: 's1', ws_path: '/api/sessions/s1/ws' }, 201))
    expect(await startSession({ envId: 'flappy_bird', mode: 'human' })).toEqual({
      ok: true,
      session: { id: 's1', wsPath: '/api/sessions/s1/ws' },
    })
  })

  it('maps a 403 to not_allowlisted', async () => {
    stubFetch(async () => jsonResponse({ error: 'no', code: 'not_allowlisted' }, 403))
    expect(await startSession({ envId: 'flappy_bird', mode: 'human' })).toEqual({
      ok: false,
      reason: 'not_allowlisted',
    })
  })

  it('maps a 409 to already_active with the active session id', async () => {
    stubFetch(async () =>
      jsonResponse({ error: 'busy', code: 'already_active', active_session_id: 'abc' }, 409),
    )
    expect(await startSession({ envId: 'flappy_bird', mode: 'human' })).toEqual({
      ok: false,
      reason: 'already_active',
      activeSessionId: 'abc',
    })
  })

  it('sends env_id, mode, and the human-slot timeout override in the body', async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse({ id: 's1', ws_path: '/api/sessions/s1/ws' }, 201),
    )
    await startSession({ envId: 'flappy_bird', mode: 'human', humanSlotTimeoutMs: 2000 })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(init.body as string)).toMatchObject({
      env_id: 'flappy_bird',
      mode: 'human',
      human_slot_timeout_ms: 2000,
    })
  })

  it('fetches a recording as raw text', async () => {
    stubFetch(async () => new Response('header\nstate\n', { status: 200 }))
    expect(await getRecording('rec-1')).toBe('header\nstate\n')
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
      },
    ]
    const fetchMock = stubFetch(async () => jsonResponse(payload))
    expect(await listPublicSeasons('flappy bird')).toEqual(payload)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/seasons?envId=flappy%20bird')
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
})
