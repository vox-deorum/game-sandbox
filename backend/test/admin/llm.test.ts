import { afterEach, describe, expect, it } from 'vitest'

import { UpstreamCaller } from '../../src/llm/upstream.js'
import { makeConfig, openTestApp, type TestApp } from '../support/harness.js'
import { makeTestLlmOptions } from '../support/llm-options.js'
import { createLlmUpstreamStub, type LlmUpstreamStub } from '../support/llm-upstream.js'

describe('admin LLM test routes', () => {
  let testApp: TestApp | undefined
  let upstream: LlmUpstreamStub | undefined

  afterEach(async () => {
    try {
      await testApp?.close()
    } finally {
      await upstream?.close()
      testApp = undefined
      upstream = undefined
    }
  })

  async function build(
    options: { upstream?: boolean; aliases?: boolean; key?: boolean; refused?: boolean } = {},
  ) {
    upstream = createLlmUpstreamStub()
    if (options.refused) {
      upstream.app.addHook('onRequest', async (_request, reply) =>
        reply
          .code(401)
          .send({ error: { message: 'Incorrect API key', type: 'auth', code: 'invalid_api_key' } }),
      )
    }
    const upstreamUrl = options.upstream === false ? undefined : `${await upstream.listen()}/v1`
    const upstreamKey = options.key === false ? undefined : 'sk-secret-upstream'
    const llm = {
      ...makeTestLlmOptions(),
      upstreamUrl,
      upstreamKey,
      models:
        options.aliases === false ? {} : { small: { upstream: 'provider-small', costWeight: 1 } },
      defaultMaxOutputTokens: 31,
      maxOutputTokens: 64,
    }
    const caller =
      upstreamUrl === undefined
        ? undefined
        : new UpstreamCaller({
            baseURL: upstreamUrl,
            apiKey: upstreamKey,
            timeoutMs: 1_000,
            maxRetries: 0,
          })
    testApp = await openTestApp({
      config: makeConfig({ llm }),
      llmUpstream: caller,
    })
    const admin = await testApp.users.headersFor('operator', { status: 'admin' })
    return { app: testApp.app, users: testApp.users, upstream, upstreamUrl, admin }
  }

  const ping = { model: 'small', messages: [{ role: 'user', content: 'ping' }] }

  it('is limited to operators', async () => {
    const { app, users, upstream } = await build()
    const callers = [
      [{}, 401, 'auth_required'],
      [await users.headersFor('pending', { status: 'pending' }), 403, 'not_operator'],
      [await users.headersFor('guest', { status: 'guest' }), 403, 'not_operator'],
      [await users.headersFor('student', { status: 'normal' }), 403, 'not_operator'],
    ] as const
    for (const [headers, status, code] of callers) {
      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/api/admin/llm', headers }),
        app.inject({ method: 'POST', url: '/api/admin/llm/chat', headers, payload: ping }),
        app.inject({ method: 'GET', url: '/api/admin/llm/models', headers }),
      ])
      expect(responses.map((response) => [response.statusCode, response.json().code])).toEqual([
        [status, code],
        [status, code],
        [status, code],
      ])
    }
    expect(upstream.requests).toEqual([])
  })

  it.each([true, false])('describes the upstream (key set: %s)', async (keySet) => {
    const { app, admin, upstreamUrl } = await build({ key: keySet })
    const response = await app.inject({ method: 'GET', url: '/api/admin/llm', headers: admin })
    expect([response.statusCode, response.json()]).toEqual([
      200,
      {
        upstream_url: upstreamUrl,
        key_set: keySet,
        models: [{ alias: 'small', upstream_model: 'provider-small', cost_weight: 1 }],
        default_max_output_tokens: 31,
        max_output_tokens: 64,
      },
    ])
  })

  it.each([true, false])('lists sorted upstream models (aliases mapped: %s)', async (aliases) => {
    const { app, admin } = await build({ aliases })
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/llm/models',
      headers: admin,
    })
    expect([response.statusCode, response.json()]).toEqual([
      200,
      { models: ['provider-large', 'provider-small'] },
    ])
  })

  it.each([
    ['GET', '/models'],
    ['POST', '/chat'],
  ] as const)('reports a provider refusal as a gateway error for %s %s', async (method, path) => {
    const { app, admin } = await build({ refused: true })
    const response = await app.inject({
      method,
      url: `/api/admin/llm${path}`,
      headers: admin,
      ...(method === 'POST' ? { payload: ping } : {}),
    })
    expect([response.statusCode, response.json()]).toEqual([
      502,
      {
        error: { message: 'Incorrect API key', type: 'auth', code: 'invalid_api_key' },
        upstream_status: 401,
      },
    ])
  })

  it.each([
    [{ max_completion_tokens: 16 }, 16],
    [{}, 31],
  ] as const)('sends a mapped test call with output limit %j', async (limit, expectedMaximum) => {
    const { app, admin, upstream } = await build()
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: { ...ping, ...limit },
    })
    expect([response.statusCode, response.json().completion?.choices[0]?.message]).toEqual([
      200,
      { role: 'assistant', content: 'Play the lowest legal card.' },
    ])
    expect(upstream.requests.map((request) => request.body)).toEqual([
      {
        model: 'provider-small',
        messages: [{ role: 'user', content: 'ping' }],
        max_completion_tokens: expectedMaximum,
      },
    ])
  })

  it.each([
    [{ model: 'large' }, 'model_not_allowed'],
    [{ max_completion_tokens: 65 }, 'invalid_max_tokens'],
  ] as const)('refuses invalid test requests %j without calling the provider', async (invalid, code) => {
    const { app, admin, upstream } = await build()
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: { ...ping, ...invalid },
    })
    expect([response.statusCode, response.json().error?.code]).toEqual([400, code])
    expect(upstream.requests).toEqual([])
  })

  it('refuses test calls and model listing when no upstream is configured', async () => {
    const { app, admin } = await build({ upstream: false })
    const chat = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: ping,
    })
    const models = await app.inject({ method: 'GET', url: '/api/admin/llm/models', headers: admin })
    expect(
      [chat, models].map((response) => [response.statusCode, response.json().error?.code]),
    ).toEqual([
      [403, 'llm_not_enabled'],
      [403, 'llm_not_enabled'],
    ])
  })
})
