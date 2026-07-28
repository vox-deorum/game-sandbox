/**
 * Stage 9.7 wiring coverage for the public development route. Unlike the unit route suite this
 * talks through the real OpenAI client to the same deterministic HTTP upstream used by workflows.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EnvironmentRegistry } from '../../src/environments.js'
import {
  DevelopmentKeyService,
  type DevelopmentKeyStorage,
} from '../../src/llm/development-keys.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { LlmMeter } from '../../src/llm/meter.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'
import type { Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore } from '../../src/storage/llm/development-ledger/index.js'
import { makeConfig, openTestApp, type TestApp } from '../support/harness.js'
import { makeTestLlmOptions } from '../support/llm-options.js'
import { createLlmUpstreamStub, RETRY_SUCCESS_ATTEMPTS } from './support/llm-upstream.js'

function environments(): EnvironmentRegistry {
  return EnvironmentRegistry.parse(
    JSON.stringify([
      {
        env_id: 'llm_env',
        display_name: 'LLM Environment',
        description: 'test env',
        layout: { kind: 'player_bounds', min: 1, max: 1 },
        human_players: [],
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
        parameters: [
          {
            name: 'players',
            title: 'Players',
            description: 'Number of players.',
            type: 'int',
            default: 1,
            min: 1,
            max: 1,
          },
        ],
      },
      {
        env_id: 'llm_env_other',
        display_name: 'Other LLM Environment',
        description: 'test env',
        layout: { kind: 'player_bounds', min: 1, max: 1 },
        human_players: [],
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
        parameters: [
          {
            name: 'players',
            title: 'Players',
            description: 'Number of players.',
            type: 'int',
            default: 1,
            min: 1,
            max: 1,
          },
        ],
      },
    ]),
  )
}

describe('development LLM HTTP wiring (integration)', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  it('isolates participant-season keys and usage, rotates without forgiveness, and forwards only the upstream credential', async () => {
    const upstream = createLlmUpstreamStub()
    const upstreamAddress = await upstream.listen()
    cleanup.push(() => upstream.close())
    const root = mkdtempSync(join(tmpdir(), 'gs-development-integration-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    const meter = new LlmMeter()
    cleanup.push(() => ledger.close())
    const llm = {
      ...makeTestLlmOptions(),
      upstreamUrl: `${upstreamAddress}/v1`,
      upstreamKey: 'upstream-secret',
      upstreamMaxRetries: 2,
      models: { small: { upstream: 'provider-small', costWeight: 1 } },
      developmentLimits: { tokenBudget: 100, requestsPerMinute: 10 },
    }
    let storage: Storage | undefined
    const keyStorage: DevelopmentKeyStorage = {
      getSeason: (id) => requireStorage(storage).getSeason(id),
      rotateDevelopmentKey: (input) => requireStorage(storage).rotateDevelopmentKey(input),
      getDevelopmentKeyByKeyId: (id) => requireStorage(storage).getDevelopmentKeyByKeyId(id),
    }
    const statuses = new Map<string, 'normal'>()
    let randomByte = 0
    const keys = new DevelopmentKeyService({
      storage: keyStorage,
      environments: environments(),
      llm,
      meter,
      ledger,
      publicOrigin: 'https://sandbox.test',
      readUserStatus: async (id) => statuses.get(id) ?? null,
      random: (bytes) => Buffer.alloc(bytes, ++randomByte),
    })
    const handler = new LlmHandler({
      meter,
      tokenizer: { countRequest: () => 2, countCompletion: () => 1 },
      upstream: new UpstreamCaller({
        baseURL: llm.upstreamUrl,
        apiKey: llm.upstreamKey,
        timeoutMs: 5_000,
        maxRetries: llm.upstreamMaxRetries,
      }),
      options: { defaultMaxOutputTokens: 3, maxOutputTokens: 8 },
    })
    const testApp = await openTestApp({
      environments: environments(),
      config: makeConfig({ llm }),
      llmDevelopment: { keys, handler, ledger },
    })
    storage = testApp.storage
    cleanup.push(() => testApp.close())

    const seasonA = await enabledSeason(testApp, 'A')
    const seasonB = await enabledSeason(testApp, 'B', 5, 'llm_env_other')
    const alice = await issue(testApp, statuses, seasonA, 'alice')
    const bob = await issue(testApp, statuses, seasonA, 'bob')
    const aliceOtherSeason = await issue(testApp, statuses, seasonB, 'alice')

    await complete(testApp, alice, '[stub:retry-success:alice-a-1] hello', 'max_tokens')
    await complete(testApp, bob, 'hello', 'max_completion_tokens')
    await complete(testApp, aliceOtherSeason, 'hello', undefined)

    expect(upstream.requests).toHaveLength(5)
    expect(upstream.requests.map((request) => request.model)).toEqual([
      'provider-small',
      'provider-small',
      'provider-small',
      'provider-small',
      'provider-small',
    ])
    expect(
      upstream.requests.every((request) => request.authorization === 'Bearer upstream-secret'),
    ).toBe(true)
    expect(upstream.requests.at(0)?.body.max_tokens).toBe(3)
    expect(upstream.requests.at(3)?.body.max_completion_tokens).toBe(3)
    expect(upstream.requests.at(4)?.body.max_completion_tokens).toBe(3)
    const retryRequests = upstream.requests.filter(
      (request) => request.logicalRequestId === 'alice-a-1',
    )
    expect(retryRequests).toHaveLength(RETRY_SUCCESS_ATTEMPTS)

    expect(ledger.readUserUsageByModel(seasonA, testApp.users.idOf('alice'))).toMatchObject({
      small: { calls: 1 },
    })
    expect(ledger.readUserUsageByModel(seasonA, testApp.users.idOf('bob'))).toMatchObject({
      small: { calls: 1 },
    })
    expect(ledger.readUserUsageByModel(seasonB, testApp.users.idOf('alice'))).toMatchObject({
      small: { calls: 1 },
    })
    // This HTTP case now exhausts season B's 5-token budget. The meter's per-pair 429 rate-limit
    // path remains covered by the independent-accounting test in test/llm/core.test.ts.
    const attemptsBeforeTokenBudget = upstream.requests.length
    expect(
      (await completionResponse(testApp, aliceOtherSeason, 'over token budget')).statusCode,
    ).toBe(400)
    expect(upstream.requests).toHaveLength(attemptsBeforeTokenBudget)
    expect(
      (await completionResponse(testApp, bob, 'season A pair remains admitted')).statusCode,
    ).toBe(200)

    const rotated = await issue(testApp, statuses, seasonA, 'alice')
    expect(rotated).not.toBe(alice)
    expect((await completionResponse(testApp, alice, 'old key')).statusCode).toBe(401)
    expect(ledger.readUserUsageByModel(seasonA, testApp.users.idOf('alice'))).toMatchObject({
      small: { calls: 1 },
    })

    await testApp.storage.setSubmissionStatus(seasonA, 'closed')
    const beforeClosure = upstream.requests.length
    expect((await completionResponse(testApp, rotated, 'closed')).statusCode).toBe(403)
    const closedRotation = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${seasonA}/llm-development-key`,
      headers: await testApp.users.headersFor('alice'),
    })
    expect(closedRotation.statusCode).toBe(403)
    expect(upstream.requests).toHaveLength(beforeClosure)
    await testApp.storage.setSubmissionStatus(seasonA, 'open')
    expect((await completionResponse(testApp, rotated, 'reopened')).statusCode).toBe(200)

    const beforeFailures = upstream.requests.length
    expect(
      (await completionResponse(testApp, rotated, '[stub:non-retryable] nope')).statusCode,
    ).toBe(400)
    expect(
      (await completionResponse(testApp, rotated, '[stub:retry-exhausted] nope')).statusCode,
    ).toBe(503)
    expect(upstream.requests).toHaveLength(beforeFailures + 4)
    expect(
      ledger.listUserCalls(seasonA, testApp.users.idOf('alice'), { limit: 25 }).calls,
    ).toHaveLength(2)

    const cases = [
      { scenario: 'missing-usage', estimated: true },
      { scenario: 'malformed-usage', estimated: true },
      { scenario: 'special-tokens', estimated: false },
      { scenario: 'provider-metadata', estimated: false },
      { scenario: 'delayed-success', estimated: false },
    ] as const
    for (const item of cases) {
      const response = await completionResponse(testApp, rotated, `[stub:${item.scenario}] payload`)
      expect(response.statusCode).toBe(200)
      const body = response.json() as Record<string, unknown>
      expect(body.model).toBe('small')
      expect(body).not.toHaveProperty('provider')
      const call = ledger.listUserCalls(seasonA, testApp.users.idOf('alice'), { limit: 1 }).calls[0]
      expect(call?.usageEstimated).toBe(item.estimated)
      if (item.scenario === 'special-tokens') {
        expect(JSON.stringify(body)).toContain('<|endoftext|> ordinary completion content')
      }
      if (item.scenario === 'provider-metadata') {
        expect(JSON.stringify(body)).toContain('Play the lowest legal card.')
      }
      if (item.scenario === 'delayed-success') expect(call?.latencyMs).toBeGreaterThanOrEqual(140)
    }
    const retryCall = ledger
      .listUserCalls(seasonA, testApp.users.idOf('alice'), { limit: 25 })
      .calls.find((call) => JSON.stringify(call.request).includes('alice-a-1'))
    expect(retryCall?.latencyMs).toBeGreaterThanOrEqual(50)

    expect(await testApp.storage.listSessions()).toEqual([])
    expect(await testApp.storage.listRecordings()).toEqual([])
    expect(await testApp.storage.listRunsBySeason(seasonA)).toEqual([])
  })
})

function requireStorage(storage: Storage | undefined): Storage {
  if (storage === undefined) throw new Error('test storage is not ready')
  return storage
}

async function enabledSeason(
  testApp: TestApp,
  label: string,
  tokenBudget = 100,
  environmentId = 'llm_env',
): Promise<string> {
  const season = await testApp.storage.createSeason({
    env_id: environmentId,
    deps_version: 1,
    label,
  })
  await testApp.storage.updateSeasonConfig(season.id, {
    deps_version: 1,
    matches: [],
    overrides: {
      llm: {
        enabled: true,
        models: ['small'],
        development: { token_budget: tokenBudget, rate_limit_rpm: 10 },
      },
    },
  })
  const opened = await testApp.storage.setSubmissionStatus(season.id, 'open')
  expect(opened).toMatchObject({ ok: true })
  return season.id
}

async function issue(
  testApp: TestApp,
  statuses: Map<string, 'normal'>,
  seasonId: string,
  user: string,
): Promise<string> {
  const headers = await testApp.users.headersFor(user)
  statuses.set(testApp.users.idOf(user), 'normal')
  const response = await testApp.app.inject({
    method: 'POST',
    url: `/api/seasons/${seasonId}/llm-development-key`,
    headers,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { api_key: string }).api_key
}

async function complete(
  testApp: TestApp,
  key: string,
  content: string,
  limit: 'max_tokens' | 'max_completion_tokens' | undefined,
): Promise<void> {
  const response = await completionResponse(testApp, key, content, limit)
  expect(response.statusCode).toBe(200)
}

function completionResponse(
  testApp: TestApp,
  key: string,
  content: string,
  limit?: 'max_tokens' | 'max_completion_tokens',
) {
  return testApp.app.inject({
    method: 'POST',
    url: '/api/llm/v1/chat/completions',
    headers: { authorization: `Bearer ${key}` },
    payload: {
      model: 'small',
      messages: [{ role: 'user', content }],
      ...(limit === undefined ? {} : { [limit]: 3 }),
    },
  })
}
