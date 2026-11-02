import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserStatus } from '../../src/auth/identity.js'
import { DevelopmentKeyService } from '../../src/llm/development-keys.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { Storage } from '../../src/storage/index.js'
import { DevelopmentLedgerStore } from '../../src/storage/llm/development-ledger/index.js'
import type { LlmOverride } from '../../src/storage/season-config.js'
import { makeConfig, openTestApp } from '../support/harness.js'
import { llmEnvironments, llmMeta, makeTestLlmOptions } from '../support/llm-options.js'

describe('development LLM API', () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })

  async function fixture(offline = false) {
    const root = mkdtempSync(join(tmpdir(), 'gs-development-api-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const ledger = new DevelopmentLedgerStore(join(root, 'ledger'))
    cleanups.push(() => ledger.close())
    const statuses = new Map<string, UserStatus | null>()
    const environments = llmEnvironments(llmMeta({ env_id: 'llm_env_other' }))
    const llm = {
      ...makeTestLlmOptions(),
      ...(offline ? {} : { upstreamUrl: 'https://provider.test/v1' }),
      models: offline
        ? {}
        : {
            small: { upstream: 'provider-small', costWeight: 1 },
            medium: { upstream: 'provider-medium', costWeight: 2 },
          },
      developmentLimits: { tokenBudget: 100, requestsPerMinute: 10 },
    }
    let storage: Storage
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
      readUserStatus: async (id) => statuses.get(id) ?? null,
    })
    const upstream = {
      call: vi.fn(async () => ({
        completion: {
          id: 'completion-1',
          object: 'chat.completion' as const,
          created: 1,
          model: 'provider-small',
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        },
        latencyMs: 17,
      })),
    }
    const handler = new LlmHandler({
      meter: new LlmMeter(),
      tokenizer: { countRequest: () => 3, countCompletion: () => 5 },
      upstream,
      options: { defaultMaxOutputTokens: 8, maxOutputTokens: 20 },
    })
    const testApp = await openTestApp({
      environments,
      config: makeConfig({ llm }),
      llmDevelopment: { keys, ...(offline ? {} : { handler }), ledger },
    })
    storage = testApp.storage
    cleanups.push(() => testApp.close())

    const policy = (id: string, llm: LlmOverride) =>
      storage.updateSeasonConfig(id, {
        deps_version: 1,
        matches: [],
        overrides: { llm: { enabled: true, models: ['small'], ...llm } },
      })
    const season = async (environment = 'llm_env', llm: LlmOverride = {}) => {
      const row = await storage.createSeason({ env_id: environment, deps_version: 1 })
      await policy(row.id, llm)
      await storage.setSubmissionStatus(row.id, 'open')
      return row.id
    }
    const issue = async (id: string, name: string) => {
      const headers = await testApp.users.headersFor(name)
      statuses.set(testApp.users.idOf(name), 'normal')
      const response = await testApp.app.inject({
        method: 'POST',
        url: `/api/seasons/${id}/llm-development-key`,
        headers,
      })
      expect(response.statusCode).toBe(200)
      return response.json().api_key as string
    }
    const call = (key: string, model = 'small') =>
      testApp.app.inject({
        method: 'POST',
        url: '/api/llm/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model, messages: [] },
      })
    const read = async (url: string, headers: Record<string, string>) => {
      const response = await testApp.app.inject({ method: 'GET', url, headers })
      expect(response.statusCode).toBe(200)
      return response.json()
    }
    return { testApp, ledger, upstream, statuses, policy, season, issue, call, read }
  }

  it('checks a pasted key without spending budget', async () => {
    const { testApp, ledger, upstream, season, issue, call, read } = await fixture()
    const id = await season('llm_env', { development: { token_budget: 11, rate_limit_rpm: 1 } })
    const key = await issue(id, 'alice')
    const headers = { authorization: `Bearer ${key}` }
    for (let check = 0; check < 2; check++) {
      expect(await read('/api/llm/v1/key', headers)).toMatchObject({
        season_id: id,
        environment: 'llm_env',
        models: ['small'],
        cost_weights: { small: 1 },
        limits: { token_budget: 11, rate_limit_rpm: 1 },
        successful_calls: 0,
        budget_cost_units_remaining: 11,
        key_exists: true,
      })
    }
    expect(upstream.call).not.toHaveBeenCalled()
    expect(ledger.listUserCalls(id, testApp.users.idOf('alice'), { limit: 1 }).calls).toEqual([])
    const wrong = await testApp.app.inject({
      method: 'GET',
      url: '/api/llm/v1/key',
      headers: { authorization: `Bearer ${key}x` },
    })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json()).toMatchObject({ error: { code: 'invalid_api_key' } })
    expect((await call(key)).statusCode).toBe(200)
    expect(await read('/api/llm/v1/key', headers)).toMatchObject({
      successful_calls: 1,
      budget_cost_units_used: 6,
      budget_cost_units_remaining: 5,
    })
    await testApp.storage.setSubmissionStatus(id, 'closed')
    const closed = await testApp.app.inject({ method: 'GET', url: '/api/llm/v1/key', headers })
    expect(closed.statusCode).toBe(403)
    expect(closed.json()).toMatchObject({ error: { code: 'development_closed' } })
  })

  it.each([
    ['syntactically invalid', '{'],
    ['empty', ''],
  ])('returns the OpenAI-compatible error envelope for %s completion JSON', async (_case, payload) => {
    const { testApp, upstream } = await fixture()
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/llm/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'invalid_request' },
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

  it('retries a development-ledger preflight failure without poisoning the meter scope', async () => {
    const { testApp, ledger, upstream, season, issue, call } = await fixture()
    const id = await season()
    const key = await issue(id, 'alice')
    vi.spyOn(ledger, 'open').mockImplementationOnce(() => {
      throw new Error('storage unavailable')
    })
    const failed = await call(key)
    expect(failed.statusCode).toBe(503)
    expect(failed.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
    expect(upstream.call).not.toHaveBeenCalled()
    expect(ledger.listUserCalls(id, testApp.users.idOf('alice'), { limit: 1 }).calls).toEqual([])
    const recovered = await call(key)
    expect(recovered.statusCode).toBe(200)
    expect(recovered.json()).toMatchObject({ model: 'small', choices: [] })
    expect(ledger.readUserUsageByModel(id, testApp.users.idOf('alice'))).toEqual({
      small: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 4 },
    })
  })

  it('keeps only the failing participant-season unavailable after accounting failure', async () => {
    const { testApp, ledger, upstream, season, issue, call } = await fixture()
    const id = await season()
    const otherSeason = await season('llm_env_other')
    const alice = await issue(id, 'alice')
    const bob = await issue(id, 'bob')
    const aliceOther = await issue(otherSeason, 'alice')
    const aliceId = testApp.users.idOf('alice')
    ledger.open(id)
    const db = new BetterSqlite3(ledger.pathForSeason(id))
    try {
      db.exec(`CREATE TRIGGER fail_call AFTER INSERT ON calls
        BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;`)
      const failed = await call(alice)
      expect(failed.statusCode).toBe(503)
      expect(failed.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
      expect(upstream.call).toHaveBeenCalledOnce()
      expect(ledger.listUserCalls(id, aliceId, { limit: 1 }).calls).toEqual([])
      expect(ledger.readUserUsageByModel(id, aliceId)).toEqual({})
      db.exec('DROP TRIGGER fail_call')
      const blocked = await call(alice)
      expect(blocked.statusCode).toBe(503)
      expect(blocked.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
      expect(upstream.call).toHaveBeenCalledOnce()
      expect((await call(bob)).statusCode).toBe(200)
      expect((await call(aliceOther)).statusCode).toBe(200)
      for (const [seasonId, userId] of [
        [id, testApp.users.idOf('bob')],
        [otherSeason, aliceId],
      ] as const) {
        expect(ledger.readUserUsageByModel(seasonId, userId)).toEqual({
          small: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 4 },
        })
      }
    } finally {
      db.close()
    }
  })

  it('keeps closed-season history readable without an upstream handler', async () => {
    const { testApp, ledger, season, read } = await fixture(true)
    const id = await season()
    const headers = await testApp.users.headersFor('alice')
    const userId = testApp.users.idOf('alice')
    const rotate = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${id}/llm-development-key`,
      headers,
    })
    expect(rotate.statusCode).toBe(403)
    expect(rotate.json()).toMatchObject({ error: { code: 'llm_not_enabled' } })
    ledger.record(id, {
      userId,
      model: 'small',
      request: { messages: ['retained request'] },
      completion: { choices: ['retained response'] },
      inputTokens: 2,
      reasoningTokens: 1,
      outputTokens: 4,
      usageEstimated: false,
      latencyMs: 50,
    })
    await testApp.storage.setSubmissionStatus(id, 'closed')
    const operator = await testApp.users.headersFor('operator', { status: 'admin' })
    expect(await read(`/api/seasons/${id}/llm-development`, headers)).toMatchObject({
      successful_calls: 1,
      budget_cost_units_used: 0,
      budget_cost_units_remaining: 100,
    })
    expect(await read(`/api/admin/seasons/${id}/llm-development`, operator)).toEqual([
      expect.objectContaining({
        user_id: userId,
        successful_calls: 1,
        budget_cost_units_used: 0,
        budget_cost_units_remaining: 100,
      }),
    ])
    for (const [url, auth] of [
      [`/api/seasons/${id}/llm-development/calls`, headers],
      [`/api/admin/seasons/${id}/llm-development/users/${userId}/calls`, operator],
    ] as const) {
      expect(await read(url, auth)).toMatchObject({
        calls: [
          expect.objectContaining({
            cost_weight: 0,
            budget_cost_units: 0,
            input_tokens: 2,
            reasoning_tokens: 1,
            output_tokens: 4,
            request: { messages: ['retained request'] },
            completion: { choices: ['retained response'] },
          }),
        ],
        next_cursor: null,
      })
    }
  })

  it('serves private participant reads and guarded operator reads under current policy after closure', async () => {
    const { testApp, ledger, season, policy, issue, read } = await fixture()
    const id = await season('llm_env', { models: ['small', 'medium'] })
    await testApp.storage.setSeasonLabel(id, 'LLM Week')
    const alice = await testApp.users.headersFor('alice')
    const bob = await testApp.users.headersFor('bob')
    const aliceId = testApp.users.idOf('alice')
    const bobId = testApp.users.idOf('bob')
    expect(await read('/api/llm-development/seasons', alice)).toEqual([
      expect.objectContaining({ season_id: id, key_exists: false }),
    ])
    expect(await testApp.storage.getDevelopmentKey(id, aliceId)).toBeUndefined()
    const key = await issue(id, 'alice')
    const row = {
      userId: aliceId,
      model: 'small',
      inputTokens: 2,
      reasoningTokens: 1,
      outputTokens: 4,
      usageEstimated: false,
      latencyMs: 50,
      request: { messages: ['alice older'] },
      completion: { choices: ['a1'] },
    }
    ledger.record(id, row)
    ledger.record(id, {
      ...row,
      userId: bobId,
      inputTokens: 4,
      reasoningTokens: 0,
      outputTokens: 2,
      request: { messages: ['bob private'] },
      completion: { choices: ['b1'] },
    })
    ledger.record(id, {
      ...row,
      model: 'medium',
      inputTokens: 1,
      reasoningTokens: 2,
      outputTokens: 3,
      usageEstimated: true,
      request: { messages: ['alice newer'] },
      completion: { choices: ['a2'] },
    })
    await policy(id, { models: ['small', 'medium'], cost_weights: { small: 1.5, medium: 3 } })
    const summaryUrl = `/api/seasons/${id}/llm-development`
    const callsUrl = `${summaryUrl}/calls`
    const pending = await testApp.users.headersFor('pending-reader', { status: 'pending' })
    const banned = await testApp.users.headersFor('banned-reader')
    await testApp.users.ban('banned-reader')
    for (const [headers, status] of [
      [{}, 401],
      [pending, 403],
      [banned, 401],
    ] as const) {
      for (const url of [summaryUrl, callsUrl, '/api/llm-development/seasons']) {
        expect((await testApp.app.inject({ method: 'GET', url, headers })).statusCode).toBe(status)
      }
    }
    const discovery = await read('/api/llm-development/seasons', alice)
    expect(discovery).toEqual([
      expect.objectContaining({
        season_id: id,
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
    expect(JSON.stringify(discovery)).not.toContain(key)
    expect(discovery[0]).not.toHaveProperty('api_key')
    expect(discovery[0]).not.toHaveProperty('secret_hash')
    expect(await read('/api/llm/v1/key', { authorization: `Bearer ${key}` })).toMatchObject({
      season_id: id,
    })
    const summary = await read(summaryUrl, alice)
    expect(summary).toMatchObject({
      models: expect.arrayContaining(['medium', 'small']),
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
    expect(summary).not.toHaveProperty('api_key')
    expect(summary).not.toHaveProperty('secret_hash')
    const first = await read(`${callsUrl}?limit=1&user_id=${bobId}`, alice)
    expect(first).toMatchObject({
      calls: [
        expect.objectContaining({
          id: 3,
          model: 'medium',
          usage_estimated: true,
          cost_weight: 3,
          budget_cost_units: 12,
          request: { messages: ['alice newer'] },
          completion: { choices: ['a2'] },
        }),
      ],
      next_cursor: 3,
    })
    expect(first.calls).toHaveLength(1)
    expect(first.calls[0]).not.toHaveProperty('latency_ms')
    expect(JSON.stringify(first)).not.toContain('bob private')
    expect(await read(`${callsUrl}?limit=1&cursor=${first.next_cursor}`, alice)).toMatchObject({
      calls: [expect.objectContaining({ id: 1, budget_cost_units: 9 })],
      next_cursor: null,
    })
    const adminUrl = `/api/admin/seasons/${id}/llm-development`
    for (const url of [adminUrl, `${adminUrl}/users/${aliceId}/calls`]) {
      expect((await testApp.app.inject({ method: 'GET', url, headers: bob })).statusCode).toBe(403)
    }
    const operator = await testApp.users.headersFor('operator', { status: 'admin' })
    const totals = await read(adminUrl, operator)
    expect(totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: aliceId,
          successful_calls: 2,
          usage_estimated: true,
          budget_cost_units_used: 21,
          budget_cost_units_remaining: 79,
        }),
        expect.objectContaining({
          user_id: bobId,
          successful_calls: 1,
          usage_estimated: false,
          budget_cost_units_used: 9,
          budget_cost_units_remaining: 91,
        }),
      ]),
    )
    const bobCalls = await read(`${adminUrl}/users/${bobId}/calls`, operator)
    expect(bobCalls).toMatchObject({
      calls: [
        expect.objectContaining({
          id: 2,
          request: { messages: ['bob private'] },
          completion: { choices: ['b1'] },
        }),
      ],
      next_cursor: null,
    })
    await testApp.storage.setSubmissionStatus(id, 'closed')
    await season('llm_env', { enabled: false })
    expect(await read('/api/llm-development/seasons', alice)).toEqual([])
    expect(await read(summaryUrl, alice)).toEqual(summary)
    expect(await read(`${adminUrl}/users/${bobId}/calls`, operator)).toEqual(bobCalls)
    expect(await read(adminUrl, operator)).toEqual(totals)
    expect((await read(callsUrl, alice)).calls).toHaveLength(2)
  })

  it('applies current account and season policy to existing credentials', async () => {
    const { testApp, upstream, statuses, season, policy, issue, call, read } = await fixture()
    const id = await season('llm_env', { models: ['small', 'medium'] })
    const pending = await testApp.app.inject({
      method: 'POST',
      url: `/api/seasons/${id}/llm-development-key`,
      headers: await testApp.users.headersFor('pending', { status: 'pending' }),
    })
    expect(pending.statusCode).toBe(403)
    const key = await issue(id, 'alice')
    const userId = testApp.users.idOf('alice')
    const headers = { authorization: `Bearer ${key}` }
    expect((await call(key)).statusCode).toBe(200)
    for (const status of ['pending', 'guest', null] as const) {
      statuses.set(userId, status)
      const check = await testApp.app.inject({ method: 'GET', url: '/api/llm/v1/key', headers })
      const completion = await call(key)
      for (const response of [check, completion]) {
        expect(response.statusCode).toBe(403)
        expect(response.json()).toMatchObject({ error: { code: 'account_not_active' } })
      }
    }
    statuses.set(userId, 'admin')
    expect((await call(key, 'medium')).statusCode).toBe(200)
    await policy(id, {
      cost_weights: { small: 3 },
      development: { token_budget: 100, rate_limit_rpm: 2 },
    })
    expect(await read('/api/llm/v1/key', headers)).toMatchObject({
      models: ['small'],
      cost_weights: { small: 3 },
      limits: { token_budget: 100, rate_limit_rpm: 2 },
      successful_calls: 2,
      budget_cost_units_used: 36,
      budget_cost_units_remaining: 64,
    })
    const removedModel = await call(key, 'medium')
    expect(removedModel.statusCode).toBe(400)
    expect(removedModel.json()).toMatchObject({ error: { code: 'model_not_allowed' } })
    const rate = await call(key)
    expect(rate.statusCode).toBe(429)
    expect(rate.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } })
    await policy(id, {
      cost_weights: { small: 3 },
      development: { token_budget: 50, rate_limit_rpm: 10 },
    })
    const budget = await call(key)
    expect(budget.statusCode).toBe(400)
    expect(budget.json()).toMatchObject({ error: { code: 'budget_exceeded' } })
    await policy(id, { enabled: false })
    const disabled = await testApp.app.inject({ method: 'GET', url: '/api/llm/v1/key', headers })
    expect(disabled.statusCode).toBe(403)
    expect(disabled.json()).toMatchObject({ error: { code: 'llm_not_enabled' } })
    expect((await call(key)).json()).toMatchObject({ error: { code: 'llm_not_enabled' } })
    expect(upstream.call).toHaveBeenCalledTimes(2)
  })

  it('bounds participant and operator history pagination at the HTTP boundary', async () => {
    const { testApp, ledger, season, read } = await fixture()
    const id = await season()
    const alice = await testApp.users.headersFor('alice')
    const userId = testApp.users.idOf('alice')
    const operator = await testApp.users.headersFor('operator', { status: 'admin' })
    for (let index = 0; index < 26; index++) {
      ledger.record(id, {
        userId,
        model: 'small',
        request: { messages: [`call ${index}`] },
        completion: { choices: [] },
        inputTokens: 1,
        reasoningTokens: 0,
        outputTokens: 1,
        usageEstimated: false,
        latencyMs: 1,
      })
    }
    for (const [url, headers] of [
      [`/api/seasons/${id}/llm-development/calls`, alice],
      [`/api/admin/seasons/${id}/llm-development/users/${userId}/calls`, operator],
    ] as const) {
      for (const [query, length, cursor] of [
        ['', 25, 2],
        ['?limit=1', 1, 26],
        ['?limit=100', 26, null],
      ] as const) {
        const page = await read(`${url}${query}`, headers)
        expect(page.calls).toHaveLength(length)
        expect(page.calls[0].id).toBe(26)
        expect(page.next_cursor).toBe(cursor)
      }
      for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=0', 'cursor=1.5']) {
        const invalid = await testApp.app.inject({ method: 'GET', url: `${url}?${query}`, headers })
        expect(invalid.statusCode).toBe(400)
        expect(invalid.json()).toMatchObject({ code: 'invalid_pagination' })
      }
    }
  })

  it('skips ineligible seasons and reports infrastructure failures', async () => {
    const { testApp, season, read } = await fixture()
    const eligible = await season()
    await season('missing_env')
    const other = await season('llm_env_other')
    const headers = await testApp.users.headersFor('reader')
    const discovery = await read('/api/llm-development/seasons', headers)
    expect(discovery.map((row: { season_id: string }) => row.season_id).sort()).toEqual(
      [eligible, other].sort(),
    )
    vi.spyOn(testApp.storage, 'getSeason').mockRejectedValueOnce(new Error('storage unavailable'))
    const failed = await testApp.app.inject({
      method: 'GET',
      url: '/api/llm-development/seasons',
      headers,
    })
    expect(failed.statusCode).toBe(500)
  })
})
