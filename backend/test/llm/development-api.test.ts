import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserStatus } from '../../src/auth/identity.js'
import {
  DevelopmentKeyService,
  type DevelopmentKeyStorage,
} from '../../src/llm/development-keys.js'
import type {
  DevelopmentCallPageView,
  DevelopmentParticipantTotalView,
} from '../../src/llm/development-views.js'
import { LlmError } from '../../src/llm/errors.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { LlmChatCompletion } from '../../src/llm/types.js'
import { UpstreamError } from '../../src/llm/upstream.js'
import type { Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore } from '../../src/storage/llm/development-ledger/index.js'
import { makeConfig, openTestApp, type TestApp } from '../support/harness.js'
import { llmEnvironments, makeTestLlmOptions } from '../support/llm-options.js'

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

  async function fixture(
    options: { upstreamConfigured?: boolean; mountHandler?: boolean; emptyModels?: boolean } = {},
  ): Promise<{
    testApp: TestApp
    ledger: DevelopmentLedgerStore
    meter: LlmMeter
    upstream: { call: ReturnType<typeof vi.fn> }
    statuses: Map<string, UserStatus | null>
    keys: DevelopmentKeyService
  }> {
    const root = mkdtempSync(join(tmpdir(), 'gs-development-api-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    cleanups.push(() => ledger.close())
    const meter = new LlmMeter()
    const statuses = new Map<string, UserStatus | null>()
    const environments = llmEnvironments()
    const baseLlm = makeTestLlmOptions()
    const { upstreamUrl: _upstreamUrl, ...llmWithoutUpstream } = baseLlm
    const llm = {
      ...(options.upstreamConfigured === false ? llmWithoutUpstream : baseLlm),
      ...(options.upstreamConfigured === false ? {} : { upstreamUrl: 'https://provider.test/v1' }),
      models: options.emptyModels
        ? {}
        : {
            small: { upstream: 'provider-small', costWeight: 1 },
            medium: { upstream: 'provider-medium', costWeight: 2 },
          },
      developmentLimits: { tokenBudget: 100, requestsPerMinute: 10 },
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
      llmDevelopment: {
        keys,
        ...(options.mountHandler === false ? {} : { handler }),
        ledger,
      },
    })
    storage = testApp.storage
    cleanups.push(() => testApp.close())
    return { testApp, ledger, meter, upstream, statuses, keys }
  }

  async function enabledSeason(testApp: TestApp): Promise<string> {
    const season = await testApp.storage.createSeason({ env_id: 'llm_env', deps_version: 1 })
    await testApp.storage.updateSeasonConfig(season.id, {
      deps_version: 1,
      matches: [],
      overrides: { llm: { enabled: true, models: ['small'] } },
    })
    await testApp.storage.setSubmissionStatus(season.id, 'open')
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
    expect(response.json().models).toContain('small')
    expect(response.json().cost_weights.small).toEqual(expect.any(Number))
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

  it('closes key rotation and completion access until submissions reopen', async () => {
    const { testApp, statuses } = await fixture()
    const seasonId = await enabledSeason(testApp)
    const key = await issue(testApp, statuses, seasonId, 'alice')
    const headers = await testApp.users.headersFor('alice')

    await testApp.storage.setSubmissionStatus(seasonId, 'closed')
    const rotateClosed = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${seasonId}/llm-development-key`,
      headers,
    })
    expect(rotateClosed.statusCode).toBe(403)
    expect(rotateClosed.json()).toMatchObject({ error: { code: 'development_closed' } })

    const completionClosed = await testApp.app.inject({
      method: 'POST',
      url: '/api/llm/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(completionClosed.statusCode).toBe(403)
    expect(completionClosed.json()).toMatchObject({ error: { code: 'development_closed' } })

    await testApp.storage.setSubmissionStatus(seasonId, 'open')
    const completionOpen = await testApp.app.inject({
      method: 'POST',
      url: '/api/llm/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(completionOpen.statusCode).toBe(200)
    expect(
      (
        await testApp.app.inject({
          method: 'POST',
          url: `/api/seasons/${seasonId}/llm-development-key`,
          headers,
        })
      ).statusCode,
    ).toBe(200)
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
      reservedWeightedTokens: 0,
    })
  })

  it('retries a development-ledger preflight failure without poisoning the meter scope', async () => {
    const { testApp, ledger, meter, upstream, statuses } = await fixture()
    const seasonId = await enabledSeason(testApp)
    const key = await issue(testApp, statuses, seasonId, 'alice')
    const userId = testApp.users.idOf('alice')
    const open = vi.spyOn(ledger, 'open').mockImplementationOnce(() => {
      throw new Error('storage temporarily unavailable')
    })
    const call = () =>
      testApp.app.inject({
        method: 'POST',
        url: '/api/llm/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'small', messages: [] },
      })

    const failed = await call()
    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
    expect(upstream.call).not.toHaveBeenCalled()
    expect(meter.inspect(`development:${seasonId}:${userId}`).unavailable).toBe(false)

    expect((await call()).statusCode).toBe(200)
    expect(open).toHaveBeenCalledTimes(2)
    expect(upstream.call).toHaveBeenCalledOnce()
    expect(ledger.readUserUsageByModel(seasonId, userId)).toEqual({
      small: {
        calls: 1,
        inputTokens: 2,
        reasoningTokens: 0,
        outputTokens: 4,
      },
    })
  })

  it('keeps only the failing participant-season unavailable after accounting failure', async () => {
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
      unavailable: true,
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
    expect(meter.inspect(`development:${seasonId}:${bobId}`).unavailable).toBe(false)
    expect(meter.inspect(`development:${seasonId}:${aliceId}`).unavailable).toBe(true)
  })

  it('keeps closed-season history readable without an upstream handler', async () => {
    const { testApp, ledger, statuses } = await fixture({
      upstreamConfigured: false,
      mountHandler: false,
      emptyModels: true,
    })
    const seasonId = await enabledSeason(testApp)
    const aliceHeaders = await testApp.users.headersFor('alice')
    const aliceId = testApp.users.idOf('alice')
    statuses.set(aliceId, 'normal')

    const rotate = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${seasonId}/llm-development-key`,
      headers: aliceHeaders,
    })
    expect(rotate.statusCode).toBe(403)
    expect(rotate.json()).toMatchObject({ error: { code: 'llm_not_enabled' } })

    const keyId = 'retained-key'
    const secret = 'retained-secret'
    await testApp.storage.rotateDevelopmentKey({
      seasonId,
      userId: aliceId,
      keyId,
      secretHash: createHash('sha256').update(secret, 'utf8').digest('hex'),
      now: '2026-07-19T00:00:00.000Z',
    })
    const completionWithoutHandler = await testApp.app.inject({
      method: 'POST',
      url: '/api/llm/v1/chat/completions',
      headers: { authorization: `Bearer sk-sandbox-dev-${keyId}.${secret}` },
      payload: { model: 'small', messages: [] },
    })
    expect(completionWithoutHandler.statusCode).toBe(403)
    expect(completionWithoutHandler.json()).toMatchObject({
      error: { code: 'llm_not_enabled' },
    })

    ledger.record(seasonId, {
      userId: aliceId,
      model: 'small',
      request: { messages: ['retained request'] },
      completion: { choices: ['retained response'] },
      inputTokens: 2,
      reasoningTokens: 1,
      outputTokens: 4,
      usageEstimated: false,
      latencyMs: 50,
      createdAt: '2026-07-19T00:01:00.000Z',
    })
    await testApp.storage.setSubmissionStatus(seasonId, 'closed')

    const participantSummary = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${seasonId}/llm-development`,
      headers: aliceHeaders,
    })
    expect(participantSummary.statusCode).toBe(200)
    expect(participantSummary.json()).toMatchObject({
      successful_calls: 1,
      budget_cost_units_used: 0,
      budget_cost_units_remaining: 100,
    })
    const participantCalls = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${seasonId}/llm-development/calls`,
      headers: aliceHeaders,
    })
    expect(participantCalls.statusCode).toBe(200)
    expect(participantCalls.json()).toMatchObject({
      calls: [
        expect.objectContaining({
          cost_weight: 0,
          budget_cost_units: 0,
          request: { messages: ['retained request'] },
        }),
      ],
    })

    const operatorHeaders = await testApp.users.headersFor('history-operator', {
      status: 'admin',
    })
    const operatorSummary = await testApp.app.inject({
      method: 'GET',
      url: `/api/admin/seasons/${seasonId}/llm-development`,
      headers: operatorHeaders,
    })
    expect(operatorSummary.statusCode).toBe(200)
    expect(operatorSummary.json()).toEqual([
      expect.objectContaining({
        user_id: aliceId,
        successful_calls: 1,
        budget_cost_units_used: 0,
        budget_cost_units_remaining: 100,
      }),
    ])
    const operatorCalls = await testApp.app.inject({
      method: 'GET',
      url: `/api/admin/seasons/${seasonId}/llm-development/users/${aliceId}/calls`,
      headers: operatorHeaders,
    })
    expect(operatorCalls.statusCode).toBe(200)
    expect(operatorCalls.json()).toMatchObject({
      calls: [
        expect.objectContaining({
          cost_weight: 0,
          budget_cost_units: 0,
          completion: { choices: ['retained response'] },
        }),
      ],
    })
  })

  it('serves private participant reads and guarded operator reads under current policy after closure', async () => {
    const { testApp, ledger, statuses } = await fixture()
    const seasonId = await enabledSeason(testApp)
    await testApp.storage.setSeasonLabel(seasonId, 'LLM Week')
    await testApp.storage.updateSeasonConfig(seasonId, {
      deps_version: 1,
      matches: [],
      overrides: {
        llm: {
          enabled: true,
          models: ['small', 'medium'],
        },
      },
    })
    const aliceHeaders = await testApp.users.headersFor('alice')
    const bobHeaders = await testApp.users.headersFor('bob')
    const aliceId = testApp.users.idOf('alice')
    const bobId = testApp.users.idOf('bob')
    statuses.set(aliceId, 'normal')
    statuses.set(bobId, 'normal')
    await issue(testApp, statuses, seasonId, 'alice')

    ledger.record(seasonId, {
      userId: aliceId,
      model: 'small',
      request: { messages: ['alice older'] },
      completion: { choices: ['a1'] },
      inputTokens: 2,
      reasoningTokens: 1,
      outputTokens: 4,
      usageEstimated: false,
      latencyMs: 50,
      createdAt: '2026-07-19T00:00:00.000Z',
    })
    ledger.record(seasonId, {
      userId: bobId,
      model: 'small',
      request: { messages: ['bob private'] },
      completion: { choices: ['b1'] },
      inputTokens: 4,
      reasoningTokens: 0,
      outputTokens: 2,
      usageEstimated: false,
      latencyMs: 60,
      createdAt: '2026-07-19T00:01:00.000Z',
    })
    ledger.record(seasonId, {
      userId: aliceId,
      model: 'medium',
      request: { messages: ['alice newer'] },
      completion: { choices: ['a2'] },
      inputTokens: 1,
      reasoningTokens: 2,
      outputTokens: 3,
      usageEstimated: true,
      latencyMs: 70,
      createdAt: '2026-07-19T00:02:00.000Z',
    })
    await testApp.storage.updateSeasonConfig(seasonId, {
      deps_version: 1,
      matches: [],
      overrides: {
        llm: {
          enabled: true,
          models: ['small', 'medium'],
          cost_weights: { small: 1.5, medium: 3 },
        },
      },
    })

    const anonymous = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${seasonId}/llm-development`,
    })
    expect(anonymous.statusCode).toBe(401)
    const pending = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${seasonId}/llm-development`,
      headers: await testApp.users.headersFor('pending-reader', { status: 'pending' }),
    })
    expect(pending.statusCode).toBe(403)
    const bannedHeaders = await testApp.users.headersFor('banned-reader')
    await testApp.users.ban('banned-reader')
    expect(
      (
        await testApp.app.inject({
          method: 'GET',
          url: `/api/seasons/${seasonId}/llm-development`,
          headers: bannedHeaders,
        })
      ).statusCode,
    ).toBe(401)

    const keyBeforeDiscovery = await testApp.storage.getDevelopmentKey(seasonId, aliceId)
    const discovery = await testApp.app.inject({
      method: 'GET',
      url: '/api/llm-development/seasons',
      headers: aliceHeaders,
    })
    expect(discovery.statusCode).toBe(200)
    expect(discovery.json()).toEqual([
      expect.objectContaining({
        season_id: seasonId,
        label: 'LLM Week',
        environment: 'llm_env',
        cost_weights: { small: 1.5, medium: 3 },
        successful_calls: 2,
        usage_estimated: true,
        budget_cost_units_used: 21,
        budget_cost_units_remaining: 79,
        key_exists: true,
      }),
    ])
    expect(await testApp.storage.getDevelopmentKey(seasonId, aliceId)).toEqual(keyBeforeDiscovery)

    const summary = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${seasonId}/llm-development`,
      headers: aliceHeaders,
    })
    expect(summary.statusCode).toBe(200)
    expect(summary.json()).toMatchObject({
      models: ['medium', 'small'],
      cost_weights: { small: 1.5, medium: 3 },
      limits: { token_budget: 100, rate_limit_rpm: 10 },
      successful_calls: 2,
      usage_estimated: true,
      budget_cost_units_used: 21,
      budget_cost_units_remaining: 79,
      key_exists: true,
      usage_by_model: {
        small: { calls: 1, input_tokens: 2, reasoning_tokens: 1, output_tokens: 4 },
        medium: { calls: 1, input_tokens: 1, reasoning_tokens: 2, output_tokens: 3 },
      },
    })

    const firstPage = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${seasonId}/llm-development/calls?limit=1`,
      headers: aliceHeaders,
    })
    expect(firstPage.statusCode).toBe(200)
    const firstBody = firstPage.json() as DevelopmentCallPageView
    expect(firstBody.calls).toEqual([
      expect.objectContaining({
        id: 3,
        model: 'medium',
        usage_estimated: true,
        cost_weight: 3,
        budget_cost_units: 12,
        request: { messages: ['alice newer'] },
        completion: { choices: ['a2'] },
      }),
    ])
    expect(firstBody.calls[0]).not.toHaveProperty('latency_ms')
    expect(firstPage.body).not.toContain('bob private')
    const secondPage = await testApp.app.inject({
      method: 'GET',
      url: `/api/seasons/${seasonId}/llm-development/calls?limit=1&cursor=${firstBody.next_cursor}`,
      headers: aliceHeaders,
    })
    expect(secondPage.json()).toMatchObject({
      calls: [expect.objectContaining({ id: 1, budget_cost_units: 9 })],
      next_cursor: null,
    })
    expect(
      (
        await testApp.app.inject({
          method: 'GET',
          url: `/api/seasons/${seasonId}/llm-development/calls?limit=101`,
          headers: aliceHeaders,
        })
      ).statusCode,
    ).toBe(400)

    const normalAdminRead = await testApp.app.inject({
      method: 'GET',
      url: `/api/admin/seasons/${seasonId}/llm-development`,
      headers: bobHeaders,
    })
    expect(normalAdminRead.statusCode).toBe(403)
    const operatorHeaders = await testApp.users.headersFor('llm-operator', { status: 'admin' })
    const totals = await testApp.app.inject({
      method: 'GET',
      url: `/api/admin/seasons/${seasonId}/llm-development`,
      headers: operatorHeaders,
    })
    expect(totals.statusCode).toBe(200)
    const totalRows = totals.json() as DevelopmentParticipantTotalView[]
    expect(totalRows.find((row) => row.user_id === aliceId)).toMatchObject({
      successful_calls: 2,
      usage_estimated: true,
      budget_cost_units_used: 21,
      budget_cost_units_remaining: 79,
    })
    expect(totalRows.find((row) => row.user_id === bobId)).toMatchObject({
      successful_calls: 1,
      budget_cost_units_used: 9,
      budget_cost_units_remaining: 91,
    })
    const bobDetail = await testApp.app.inject({
      method: 'GET',
      url: `/api/admin/seasons/${seasonId}/llm-development/users/${bobId}/calls`,
      headers: operatorHeaders,
    })
    expect(bobDetail.statusCode).toBe(200)
    expect(bobDetail.json()).toMatchObject({
      calls: [expect.objectContaining({ id: 2, request: { messages: ['bob private'] } })],
      next_cursor: null,
    })
    expect(
      (
        await testApp.app.inject({
          method: 'GET',
          url: `/api/admin/seasons/${seasonId}/llm-development/users/${bobId}/calls?cursor=0`,
          headers: operatorHeaders,
        })
      ).statusCode,
    ).toBe(400)

    await testApp.storage.setSubmissionStatus(seasonId, 'closed')
    const disabledSeason = await testApp.storage.createSeason({
      env_id: 'llm_env',
      deps_version: 1,
    })
    await testApp.storage.setSubmissionStatus(disabledSeason.id, 'open')
    const closedDiscovery = await testApp.app.inject({
      method: 'GET',
      url: '/api/llm-development/seasons',
      headers: aliceHeaders,
    })
    expect(closedDiscovery.json()).toEqual([])
    for (const request of [
      { url: `/api/seasons/${seasonId}/llm-development`, headers: aliceHeaders },
      { url: `/api/seasons/${seasonId}/llm-development/calls`, headers: aliceHeaders },
      {
        url: `/api/admin/seasons/${seasonId}/llm-development`,
        headers: operatorHeaders,
      },
      {
        url: `/api/admin/seasons/${seasonId}/llm-development/users/${aliceId}/calls`,
        headers: operatorHeaders,
      },
    ]) {
      expect((await testApp.app.inject({ method: 'GET', ...request })).statusCode).toBe(200)
    }
  })

  it('skips expected discovery resolution errors and rethrows infrastructure failures', async () => {
    const { testApp, statuses, keys } = await fixture()
    await enabledSeason(testApp)
    const headers = await testApp.users.headersFor('discovery-reader')
    statuses.set(testApp.users.idOf('discovery-reader'), 'normal')
    const resolve = vi.spyOn(keys, 'resolveReadPolicy')

    resolve.mockRejectedValueOnce(
      new LlmError(403, 'llm_not_enabled', 'LLM access is not enabled for this season.'),
    )
    const expected = await testApp.app.inject({
      method: 'GET',
      url: '/api/llm-development/seasons',
      headers,
    })
    expect(expected.statusCode).toBe(200)
    expect(expected.json()).toEqual([])
    resolve.mockRestore()

    const readSeason = vi
      .spyOn(testApp.storage, 'getSeason')
      .mockRejectedValueOnce(new Error('season storage failed'))
    const unexpected = await testApp.app.inject({
      method: 'GET',
      url: '/api/llm-development/seasons',
      headers,
    })
    expect(unexpected.statusCode).toBe(500)
    readSeason.mockRestore()
  })
})
