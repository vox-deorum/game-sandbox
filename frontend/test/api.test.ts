import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ApiError,
  getEnvironments,
  getMe,
  getRecording,
  pinRecording,
  startSession,
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
})
