import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EnvironmentRegistry } from '../../src/environments.js'
import type { UserStatus } from '../../src/identity.js'
import {
  DevelopmentKeyService,
  type DevelopmentKeyStorage,
} from '../../src/llm/development-keys.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { LlmChatCompletion } from '../../src/llm/types.js'
import { UpstreamError } from '../../src/llm/upstream.js'
import type { Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore } from '../../src/storage/llm/development-ledger/index.js'
import { makeConfig, openTestApp, type TestApp } from '../support/harness.js'
import { makeTestLlmOptions } from '../support/llm-options.js'

function llmEnvironments(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      {
        env_id: 'llm_env',
        display_name: 'LLM Environment',
        description: 'test env',
        min_slots: 1,
        max_slots: 1,
        human_slots: [],
        human_timeout_ms: null,
        recommended_episode_ticks: 100,
        pace_interval_ms: null,
        step_limit_ms: 1_000,
        episode_limit_ms: 60_000,
        messaging: false,
        message_cap: null,
        llm: true,
        renderer: 'test',
        seat_order_matters: false,
        view_interval_ms: null,
        live_interval_ms: null,
      },
    ]),
  )
}

function completion(usage: LlmChatCompletion['usage'] = undefined): LlmChatCompletion {
  return {
    id: 'completion-1',
    object: 'chat.completion',
    created: 1,
    model: 'provider-small',
    choices: [],
    ...(usage === undefined ? {} : { usage }),
  }
}

describe('development LLM API', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function fixture(): Promise<{
    testApp: TestApp
    ledger: DevelopmentLedgerStore
    meter: LlmMeter
    upstream: { call: ReturnType<typeof vi.fn> }
    statuses: Map<string, UserStatus | null>
  }> {
    const root = mkdtempSync(join(tmpdir(), 'gs-development-api-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    cleanups.push(() => ledger.close())
    const meter = new LlmMeter({ recoveryIntervalMs: 5 })
    cleanups.push(() => meter.close())
    const statuses = new Map<string, UserStatus | null>()
    const environments = llmEnvironments()
    const llm = {
      ...makeTestLlmOptions(),
      upstreamUrl: 'https://provider.test/v1',
      models: { small: { upstream: 'provider-small', costWeight: 1 } },
      developmentLimits: { tokenBudget: 100, callBudget: 10, requestsPerMinute: 10 },
    }
    let storage: Storage | undefined
    const currentStorage = (): Storage => {
      if (storage === undefined) throw new Error('test storage is not ready')
      return storage
    }
    // The service is constructed before openTestApp exposes its storage; this narrow forwarding seam
    // still exercises the real Kysely implementation once the app has opened.
    const keyStorage: DevelopmentKeyStorage = {
      getSeason: (id) => currentStorage().getSeason(id),
      rotateDevelopmentKey: (input) => currentStorage().rotateDevelopmentKey(input),
      getDevelopmentKeyByKeyId: (keyId) => currentStorage().getDevelopmentKeyByKeyId(keyId),
    }
    let randomByte = 0
    const keys = new DevelopmentKeyService({
      storage: keyStorage,
      environments,
      llm,
      meter,
      ledger,
      publicOrigin: 'https://sandbox.test',
      readUserStatus: async (userId) => statuses.get(userId) ?? null,
      random: (bytes) => Buffer.alloc(bytes, ++randomByte),
    })
    const upstream = {
      call: vi.fn(async () => ({
        completion: completion({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }),
        latencyMs: 17,
      })),
    }
    const handler = new LlmHandler({
      meter,
      tokenizer: { countRequest: () => 3, countCompletion: () => 5 },
      upstream,
      options: { defaultMaxOutputTokens: 8, maxOutputTokens: 20 },
    })
    const testApp = await openTestApp({
      environments,
      config: makeConfig({ llm }),
      llmDevelopment: { keys, handler },
    })
    storage = testApp.storage
    cleanups.push(() => testApp.close())
    return { testApp, ledger, meter, upstream, statuses }
  }

  async function enabledSeason(testApp: TestApp): Promise<string> {
    const season = await testApp.storage.createSeason({ env_id: 'llm_env', deps_version: 1 })
    await testApp.storage.updateSeasonConfig(season.id, {
      deps_version: 1,
      matches: [],
      overrides: { llm: { enabled: true, models: ['small'] } },
    })
    return season.id
  }

  async function issue(
    testApp: TestApp,
    statuses: Map<string, UserStatus | null>,
    seasonId: string,
    name: string,
  ): Promise<string> {
    const headers = await testApp.users.headersFor(name)
    statuses.set(testApp.users.idOf(name), 'normal')
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${seasonId}/llm-development-key`,
      headers,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ models: ['small'], cost_weights: { small: 1 } })
    return response.json().api_key as string
  }

  it('issues through active identity and writes exactly one full successful row', async () => {
    const { testApp, ledger, upstream, statuses } = await fixture()
    const seasonId = await enabledSeason(testApp)
    const key = await issue(testApp, statuses, seasonId, 'alice')
    const userId = testApp.users.idOf('alice')

    const pending = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${seasonId}/llm-development-key`,
      headers: await testApp.users.headersFor('pending', { status: 'pending' }),
    })
    expect(pending.statusCode).toBe(403)

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/llm/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [{ role: 'user', content: 'hello' }] },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ model: 'small', id: 'completion-1' })
    expect(upstream.call).toHaveBeenCalledOnce()
    expect(ledger.readUserUsageByModel(seasonId, userId)).toEqual({
      small: {
        calls: 1,
        inputTokens: 2,
        reasoningTokens: 0,
        outputTokens: 4,
      },
    })
    const db = new BetterSqlite3(ledger.pathForSeason(seasonId), { readonly: true })
    expect(
      db.prepare('SELECT user_id, model, usage_estimated, latency_ms FROM calls').get(),
    ).toEqual({
      user_id: userId,
      model: 'small',
      usage_estimated: 0,
      latency_ms: 17,
    })
    db.close()
  })

  it.each([
    ['syntactically invalid', '{'],
    ['empty', ''],
  ])('returns the OpenAI-compatible error envelope for %s completion JSON', async (_case, payload) => {
    const { testApp, upstream } = await fixture()

    const malformedCompletion = await testApp.app.inject({
      method: 'POST',
      url: '/api/llm/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    expect(malformedCompletion.statusCode).toBe(400)
    expect(malformedCompletion.json()).toEqual({
      error: {
        message: 'The request body is not valid JSON.',
        type: 'invalid_request_error',
        code: 'invalid_request',
      },
    })
    expect(upstream.call).not.toHaveBeenCalled()
  })

  it('leaves unrelated malformed requests on the application error contract', async () => {
    const { testApp } = await fixture()

    // The route-local parser handler must not replace the application's normal error contract.
    const unrelatedMalformedRequest = await testApp.app.inject({
      method: 'POST',
      url: '/api/submissions/reachability',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    })
    expect(unrelatedMalformedRequest.statusCode).toBe(400)
    expect(unrelatedMalformedRequest.json()).toMatchObject({
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      error: 'Bad Request',
    })
  })

  it('keeps terminal upstream failures out of the ledger and records no rate event', async () => {
    const { testApp, ledger, meter, upstream, statuses } = await fixture()
    const seasonId = await enabledSeason(testApp)
    const key = await issue(testApp, statuses, seasonId, 'alice')
    const userId = testApp.users.idOf('alice')
    upstream.call.mockRejectedValueOnce(
      new UpstreamError(400, {
        error: { message: 'bad request', type: 'invalid_request_error', code: 'bad_request' },
      }),
    )

    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/llm/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(response.statusCode).toBe(400)
    expect(ledger.readUserUsageByModel(seasonId, userId)).toEqual({})
    expect(meter.inspect(`development:${seasonId}:${userId}`)).toMatchObject({
      rateEvents: [],
      reservedCalls: 0,
      reservedWeightedTokens: 0,
    })
  })

  it('opens and recovers only the failing participant-season breaker after accounting failure', async () => {
    const { testApp, ledger, meter, upstream, statuses } = await fixture()
    const seasonId = await enabledSeason(testApp)
    const aliceKey = await issue(testApp, statuses, seasonId, 'alice')
    const bobKey = await issue(testApp, statuses, seasonId, 'bob')
    const aliceId = testApp.users.idOf('alice')
    const bobId = testApp.users.idOf('bob')
    const originalRecord = ledger.record.bind(ledger)
    vi.spyOn(ledger, 'record').mockImplementation((recordSeasonId, input) => {
      if (input.userId === aliceId) throw new Error('disk full')
      return originalRecord(recordSeasonId, input)
    })

    const call = (key: string) =>
      testApp.app.inject({
        method: 'POST',
        url: '/api/llm/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'small', messages: [] },
      })
    const failed = await call(aliceKey)
    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
    expect(meter.inspect(`development:${seasonId}:${aliceId}`)).toMatchObject({
      breakerOpen: true,
      debt: { calls: 1, weightedTokens: 11 },
    })
    const upstreamCalls = upstream.call.mock.calls.length
    expect((await call(aliceKey)).statusCode).toBe(503)
    expect(upstream.call).toHaveBeenCalledTimes(upstreamCalls)

    expect((await call(bobKey)).statusCode).toBe(200)
    expect(ledger.readUserUsageByModel(seasonId, bobId)).toEqual({
      small: {
        calls: 1,
        inputTokens: 2,
        reasoningTokens: 0,
        outputTokens: 4,
      },
    })
    expect(meter.inspect(`development:${seasonId}:${bobId}`).breakerOpen).toBe(false)

    await vi.waitFor(
      () => expect(meter.inspect(`development:${seasonId}:${aliceId}`).breakerOpen).toBe(false),
      { timeout: 500 },
    )
    expect(meter.inspect(`development:${seasonId}:${aliceId}`).debt.calls).toBe(1)
  })
})
