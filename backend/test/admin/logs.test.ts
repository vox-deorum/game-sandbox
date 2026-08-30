import { afterEach, describe, expect, it } from 'vitest'

import { appLog, createLogBuffer } from '../../src/logging/log-buffer.js'
import { openTestApp, type TestApp } from '../support/harness.js'

describe('admin process logs', () => {
  let testApp: TestApp | undefined

  afterEach(async () => {
    await testApp?.close()
    testApp = undefined
  })

  async function build() {
    const logs = createLogBuffer({ bootId: 'boot-test', sink: () => {} })
    testApp = await openTestApp({ logs })
    const admin = await testApp.users.headersFor('operator', { status: 'admin' })
    const normal = await testApp.users.headersFor('student', { status: 'normal' })
    return { logs, app: testApp.app, admin, normal }
  }

  it('requires an administrator', async () => {
    const { app, normal } = await build()
    const anonymous = await app.inject({ method: 'GET', url: '/api/admin/logs' })
    const forbidden = await app.inject({ method: 'GET', url: '/api/admin/logs', headers: normal })
    expect(anonymous.statusCode).toBe(401)
    expect(forbidden.statusCode).toBe(403)
    expect(anonymous.headers['cache-control']).toBe('no-store')
    expect(forbidden.headers['cache-control']).toBe('no-store')
  })

  it('returns the full snapshot, filters, tails, and does not cache it', async () => {
    const { app, admin } = await build()
    appLog('main', 'started', 'info')
    appLog('auth', 'profile degraded', 'warn')
    appLog('auth', 'login failed', 'error')

    const full = await app.inject({ method: 'GET', url: '/api/admin/logs', headers: admin })
    expect(full.statusCode).toBe(200)
    expect(full.headers['cache-control']).toBe('no-store')
    expect(full.json()).toMatchObject({
      boot_id: 'boot-test',
      oldest_seq: 1,
      latest_seq: 3,
      retained_count: 3,
      sources: ['main', 'auth'],
    })

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/admin/logs?level=warn&source=auth&q=DEGRADED',
      headers: admin,
    })
    expect(filtered.json().entries).toEqual([
      expect.objectContaining({
        seq: 2,
        level: 'warn',
        source: 'auth',
        message: 'profile degraded',
      }),
    ])
    const tail = await app.inject({
      method: 'GET',
      url: '/api/admin/logs?after_seq=2',
      headers: admin,
    })
    expect(tail.json()).toMatchObject({ latest_seq: 3, history_truncated: false })
    expect(tail.json().entries).toEqual([expect.objectContaining({ seq: 3 })])
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/admin/logs?after_seq=99', headers: admin })
      ).json().entries,
    ).toEqual([])
  })

  it('rejects malformed and repeated query values', async () => {
    const { app, admin } = await build()
    for (const url of [
      '/api/admin/logs?after_seq=-1',
      '/api/admin/logs?after_seq=1.1',
      '/api/admin/logs?level=debug',
      '/api/admin/logs?source=unknown',
      '/api/admin/logs?after_seq=1&after_seq=2',
      '/api/admin/logs?extra=value',
      `/api/admin/logs?q=${'x'.repeat(201)}`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: admin })
      expect(response.statusCode).toBe(400)
      expect(response.headers['cache-control']).toBe('no-store')
    }
  })

  it('exposes history truncation without reducing global sequence metadata', async () => {
    const { logs, app, admin } = await build()
    for (let i = 0; i < 400; i++) appLog('workflow', `${i}:${'🙂'.repeat(4000)}`, 'info')
    const oldest = logs.query().oldestSeq
    expect(oldest).not.toBeNull()
    if (oldest === null) throw new Error('expected retained entries')

    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/logs?after_seq=${oldest - 2}`,
      headers: admin,
    })
    expect(response.json()).toMatchObject({
      latest_seq: 400,
      oldest_seq: oldest,
      history_truncated: true,
    })
  })

  it("captures route failures while preserving Fastify's default 500 response", async () => {
    const logs = createLogBuffer({ bootId: 'boot-test', sink: () => {} })
    testApp = await openTestApp({
      logs,
      beforeReady: (app) => {
        app.get('/test-error', () => {
          throw new Error('test failure')
        })
      },
    })
    const response = await testApp.app.inject({ method: 'GET', url: '/test-error' })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toMatchObject({ statusCode: 500, error: 'Internal Server Error' })
    expect(logs.query({ source: 'http', level: 'error' }).entries).toEqual([
      expect.objectContaining({ message: 'GET /test-error: test failure' }),
    ])
  })

  it('records a client-classified failure as a warning, so request spam cannot flood the error view', async () => {
    const logs = createLogBuffer({ bootId: 'boot-test', sink: () => {} })
    testApp = await openTestApp({
      logs,
      beforeReady: (app) => {
        app.post('/test-parse', () => ({ ok: true }))
      },
    })
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/test-parse',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })

    expect(response.statusCode).toBe(400)
    expect(logs.query({ source: 'http', level: 'error' }).entries).toEqual([])
    expect(logs.query({ source: 'http', level: 'warn' }).entries).toEqual([
      expect.objectContaining({ message: expect.stringContaining('POST /test-parse:') }),
    ])
  })
})
