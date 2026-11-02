import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { DevelopmentKeyService } from '../../src/llm/development-keys.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { LlmMeter } from '../../src/llm/meter.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'
import type { Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore } from '../../src/storage/llm/development-ledger/index.js'
import { makeConfig, openTestApp } from '../support/harness.js'
import { llmEnvironments, llmMeta, makeTestLlmOptions } from '../support/llm-options.js'
import { createLlmUpstreamStub } from '../support/llm-upstream.js'

describe('development LLM HTTP wiring', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  async function fixture(tokenBudget = 100, rateLimit = 10) {
    const upstream = createLlmUpstreamStub()
    let upstreamTime = 0
    upstream.app.addHook('preSerialization', async (_request, _reply, payload) => {
      upstreamTime += 25
      return payload
    })
    const address = await upstream.listen()
    cleanup.push(() => upstream.close())
    const root = mkdtempSync(join(tmpdir(), 'gs-development-wiring-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    cleanup.push(() => ledger.close())
    const clock = { now: 1_000 }
    const environments = llmEnvironments(llmMeta({ env_id: 'llm_env_other' }))
    const llm = {
      ...makeTestLlmOptions(),
      upstreamUrl: `${address}/v1`,
      upstreamKey: 'upstream-secret',
      models: { small: { upstream: 'provider-small', costWeight: 2 } },
      developmentLimits: { tokenBudget, requestsPerMinute: rateLimit },
    }
    let storage: Storage
    const active = new Set<string>()
    const keys = new DevelopmentKeyService({
      storage: {
        getSeason: (id) => storage.getSeason(id),
        rotateDevelopmentKey: (input) => storage.rotateDevelopmentKey(input),
        getDevelopmentKeyByKeyId: (id) => storage.getDevelopmentKeyByKeyId(id),
      },
      environments,
      llm,
      ledger,
      publicOrigin: 'https://sandbox.test',
      readUserStatus: async (id) => (active.has(id) ? 'normal' : null),
    })
    const handler = new LlmHandler({
      meter: new LlmMeter({ now: () => clock.now }),
      tokenizer: { countRequest: () => 2, countCompletion: () => 1 },
      upstream: new UpstreamCaller({
        baseURL: llm.upstreamUrl,
        apiKey: llm.upstreamKey,
        timeoutMs: 5_000,
        maxRetries: 2,
        now: () => upstreamTime,
      }),
      options: { defaultMaxOutputTokens: 3, maxOutputTokens: 8 },
    })
    const testApp = await openTestApp({
      environments,
      config: makeConfig({ llm }),
      llmDevelopment: { keys, handler, ledger },
    })
    storage = testApp.storage
    cleanup.push(() => testApp.close())
    const policy = (id: string, budget = tokenBudget) =>
      storage.updateSeasonConfig(id, {
        deps_version: 1,
        matches: [],
        overrides: {
          llm: {
            enabled: true,
            models: ['small'],
            development: { token_budget: budget, rate_limit_rpm: rateLimit },
          },
        },
      })
    const season = async (env = 'llm_env') => {
      const row = await storage.createSeason({ env_id: env, deps_version: 1 })
      await policy(row.id)
      await storage.setSubmissionStatus(row.id, 'open')
      return row.id
    }
    const issue = async (id: string, user: string) => {
      const headers = await testApp.users.headersFor(user)
      active.add(testApp.users.idOf(user))
      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/seasons/${id}/llm-development-key`,
        headers,
      })
      expect(response.statusCode).toBe(200)
      return response.json().api_key as string
    }
    const call = (key: string, content = 'hello') =>
      testApp.app.inject({
        method: 'POST',
        url: '/api/llm/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'small', messages: [{ role: 'user', content }] },
      })
    return { upstream, ledger, testApp, clock, policy, season, issue, call }
  }

  it.each([
    ['token', 16, 10, 400, 'budget_exceeded'],
    ['rate', 100, 2, 429, 'rate_limit_exceeded'],
  ] as const)('preserves %s limits across rotation and isolates participant-season pairs', async (_kind, budget, rpm, status, code) => {
    const { upstream, ledger, testApp, clock, policy, season, issue, call } = await fixture(
      budget,
      rpm,
    )
    const id = await season()
    const otherId = await season('llm_env_other')
    const alice = await issue(id, 'alice')
    const bob = await issue(id, 'bob')
    const aliceOther = await issue(otherId, 'alice')
    expect((await call(alice, '[stub:retry-success:first] hello')).statusCode).toBe(200)
    expect((await call(alice)).statusCode).toBe(200)
    expect(upstream.requests).toHaveLength(4)
    const rotated = await issue(id, 'alice')
    const old = await call(alice)
    expect(old.statusCode).toBe(401)
    expect(old.json()).toMatchObject({ error: { code: 'invalid_api_key' } })
    const limited = await call(rotated)
    expect(limited.statusCode).toBe(status)
    expect(limited.json()).toMatchObject({ error: { code } })
    expect(upstream.requests).toHaveLength(4)
    expect((await call(bob)).statusCode).toBe(200)
    expect((await call(aliceOther)).statusCode).toBe(200)
    expect(ledger.readUserUsageByModel(id, testApp.users.idOf('alice'))).toEqual({
      small: { calls: 2, inputTokens: 4, reasoningTokens: 0, outputTokens: 2 },
    })
    for (const [seasonId, userId] of [
      [id, testApp.users.idOf('bob')],
      [otherId, testApp.users.idOf('alice')],
    ] as const) {
      expect(ledger.readUserUsageByModel(seasonId, userId)).toEqual({
        small: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 1 },
      })
    }
    await testApp.storage.setSubmissionStatus(id, 'closed')
    const closed = await call(rotated)
    expect(closed.statusCode).toBe(403)
    expect(closed.json()).toMatchObject({ error: { code: 'development_closed' } })
    const rotateClosed = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${id}/llm-development-key`,
      headers: await testApp.users.headersFor('alice'),
    })
    expect(rotateClosed.statusCode).toBe(403)
    expect(rotateClosed.json()).toMatchObject({ error: { code: 'development_closed' } })
    expect(upstream.requests).toHaveLength(6)
    clock.now += 61_000
    await policy(id, 40)
    await testApp.storage.setSubmissionStatus(id, 'open')
    expect((await call(rotated)).statusCode).toBe(200)
    expect(
      upstream.requests.every((request) => request.authorization === 'Bearer upstream-secret'),
    ).toBe(true)
    expect(upstream.requests.every((request) => request.model === 'provider-small')).toBe(true)
  })

  it.each([
    ['non-retryable', 400, 'stub_400', 1],
    ['retry-exhausted', 503, 'stub_503', 3],
  ] as const)('releases development capacity after %s upstream failure', async (scenario, status, code, attempts) => {
    const { upstream, ledger, testApp, season, issue, call } = await fixture(10, 1)
    const id = await season()
    const key = await issue(id, 'alice')
    const userId = testApp.users.idOf('alice')
    const failed = await call(key, `[stub:${scenario}] rejected`)
    expect(failed.statusCode).toBe(status)
    expect(failed.json()).toMatchObject({ error: { code, type: 'stub_error' } })
    expect(upstream.requests).toHaveLength(attempts)
    expect(ledger.listUserCalls(id, userId, { limit: 1 }).calls).toEqual([])
    expect(ledger.readUserUsageByModel(id, userId)).toEqual({})
    expect((await call(key)).statusCode).toBe(200)
    expect(upstream.requests).toHaveLength(attempts + 1)
    expect(ledger.listUserCalls(id, userId, { limit: 2 }).calls).toHaveLength(1)
    expect(ledger.readUserUsageByModel(id, userId)).toEqual({
      small: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 1 },
    })
  })

  it('persists estimated usage and the exact canonical completion returned by the public route', async () => {
    const { ledger, testApp, season, issue, call } = await fixture()
    const id = await season()
    const key = await issue(id, 'alice')
    const estimated = await call(key, '[stub:missing-usage] estimate')
    const canonical = await call(key, '[stub:provider-metadata] canonical')
    expect(estimated.statusCode).toBe(200)
    expect(canonical.statusCode).toBe(200)
    expect(canonical.json()).toMatchObject({
      model: 'small',
      choices: [
        expect.objectContaining({
          message: { role: 'assistant', content: 'Play the lowest legal card.' },
        }),
      ],
    })
    expect(canonical.json()).not.toHaveProperty('provider')
    expect(ledger.listUserCalls(id, testApp.users.idOf('alice'), { limit: 10 })).toEqual({
      calls: [
        expect.objectContaining({
          userId: testApp.users.idOf('alice'),
          model: 'small',
          request: {
            model: 'small',
            max_completion_tokens: 3,
            messages: [{ role: 'user', content: '[stub:provider-metadata] canonical' }],
          },
          completion: canonical.json(),
          inputTokens: 2,
          reasoningTokens: 0,
          outputTokens: 1,
          usageEstimated: false,
          latencyMs: 25,
        }),
        expect.objectContaining({
          userId: testApp.users.idOf('alice'),
          model: 'small',
          request: {
            model: 'small',
            max_completion_tokens: 3,
            messages: [{ role: 'user', content: '[stub:missing-usage] estimate' }],
          },
          completion: estimated.json(),
          inputTokens: 2,
          reasoningTokens: 0,
          outputTokens: 1,
          usageEstimated: true,
          latencyMs: 25,
        }),
      ],
      nextCursor: null,
    })
    const summary = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${id}/llm-development`,
      headers: await testApp.users.headersFor('alice'),
    })
    expect(summary.statusCode).toBe(200)
    expect(summary.json()).toMatchObject({
      successful_calls: 2,
      usage_estimated: true,
      budget_cost_units_used: 12,
      budget_cost_units_remaining: 88,
      usage_by_model: {
        small: { calls: 2, input_tokens: 4, reasoning_tokens: 0, output_tokens: 2 },
      },
    })
  })
})
