import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, getEnvironments, getMe, startSession } from '../src/api/client.js'

const META: EnvironmentMeta = {
  env_id: 'flappy_bird',
  display_name: 'Flappy Bird',
  description: 'A paced single-human clone.',
  min_slots: 1,
  max_slots: 1,
  human_slots: ['player_0'],
  human_timeout_ms: null,
  recommended_episode_ticks: 1000,
  pace_interval_ms: 50,
  step_limit_ms: 1000,
  episode_limit_ms: 120_000,
  messaging: false,
  message_cap: null,
  llm: false,
  renderer: 'flappy-bird',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl)
  vi.stubGlobal('fetch', mock)
  return mock
}

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

  it('reports identity and allowlist membership from /api/me', async () => {
    stubFetch(async () => jsonResponse({ user_id: 'dev-user', allowlisted: true }))
    expect(await getMe()).toEqual({ user_id: 'dev-user', allowlisted: true })
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
})
