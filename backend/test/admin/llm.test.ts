import { afterEach, describe, expect, it, vi } from 'vitest'

import { UpstreamError } from '../../src/llm/upstream.js'
import { makeConfig, openTestApp, type TestApp } from '../support/harness.js'
import { makeTestLlmOptions } from '../support/llm-options.js'

const llm = {
  ...makeTestLlmOptions(),
  upstreamUrl: 'https://provider.test/v1',
  upstreamKey: 'sk-secret-upstream',
  models: { small: { upstream: 'provider-small', costWeight: 1 } },
}

describe('admin LLM test routes', () => {
  let testApp: TestApp | undefined

  afterEach(async () => {
    await testApp?.close()
    testApp = undefined
  })

  async function build(options: { configured?: boolean } = {}) {
    const upstream = {
      call: vi.fn(async () => ({
        completion: {
          id: 'c1',
          object: 'chat.completion' as const,
          created: 1,
          model: 'provider-small',
          choices: [],
        },
        latencyMs: 12,
      })),
    }
    testApp = await openTestApp({
      config: makeConfig({ llm }),
      ...(options.configured === false ? {} : { llmUpstream: upstream }),
    })
    const admin = await testApp.users.headersFor('operator', { status: 'admin' })
    const normal = await testApp.users.headersFor('student', { status: 'normal' })
    return { app: testApp.app, upstream, admin, normal }
  }

  // The testers send max_completion_tokens, which reasoning models require.
  const ping = {
    model: 'small',
    messages: [{ role: 'user', content: 'ping' }],
    max_completion_tokens: 16,
  }

  it('is limited to operators', async () => {
    const { app, normal, upstream } = await build()
    const info = await app.inject({ method: 'GET', url: '/api/admin/llm', headers: normal })
    const chat = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: normal,
      payload: ping,
    })
    expect(info.statusCode).toBe(403)
    expect(chat.statusCode).toBe(403)
    expect(upstream.call).not.toHaveBeenCalled()
  })

  it('describes the upstream without revealing its key', async () => {
    const { app, admin } = await build()
    const response = await app.inject({ method: 'GET', url: '/api/admin/llm', headers: admin })
    expect(response.json()).toEqual({
      configured: true,
      upstream_url: 'https://provider.test/v1',
      key_set: true,
      models: [{ alias: 'small', upstream_model: 'provider-small', cost_weight: 1 }],
      default_max_output_tokens: llm.defaultMaxOutputTokens,
      max_output_tokens: llm.maxOutputTokens,
    })
    expect(response.body).not.toContain('sk-secret-upstream')
  })

  it('sends a test call straight to the mapped upstream model', async () => {
    const { app, admin, upstream } = await build()
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: ping,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ completion: { id: 'c1' }, latency_ms: 12 })
    expect(upstream.call).toHaveBeenCalledWith({
      model: 'provider-small',
      messages: ping.messages,
      max_completion_tokens: 16,
    })
  })

  it('rejects unknown aliases and oversized maximums before calling upstream', async () => {
    const { app, admin, upstream } = await build()
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: { ...ping, model: 'large' },
    })
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: { ...ping, max_completion_tokens: llm.maxOutputTokens + 1 },
    })
    expect(unknown.json()).toMatchObject({ error: { code: 'model_not_allowed' } })
    expect(oversized.json()).toMatchObject({ error: { code: 'invalid_max_tokens' } })
    expect(upstream.call).not.toHaveBeenCalled()
  })

  it('reports an upstream refusal as a gateway error carrying the provider status', async () => {
    const { app, admin, upstream } = await build()
    upstream.call.mockRejectedValueOnce(
      new UpstreamError(401, {
        error: { message: 'Incorrect API key', type: 'auth', code: 'invalid_api_key' },
      }),
    )
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: ping,
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({
      error: { message: 'Incorrect API key', type: 'auth', code: 'invalid_api_key' },
      upstream_status: 401,
    })
  })

  it('refuses test calls when no upstream is configured', async () => {
    const { app, admin } = await build({ configured: false })
    const info = await app.inject({ method: 'GET', url: '/api/admin/llm', headers: admin })
    const chat = await app.inject({
      method: 'POST',
      url: '/api/admin/llm/chat',
      headers: admin,
      payload: ping,
    })
    expect(info.json()).toMatchObject({ configured: false })
    expect(chat.statusCode).toBe(403)
    expect(chat.json()).toMatchObject({ error: { code: 'llm_not_enabled' } })
  })
})
