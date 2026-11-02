import type { FastifyInstance } from 'fastify'
import type OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmError } from '../../src/llm/errors.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { createOfficialTickMarker, KeyRegistry } from '../../src/llm/key-registry.js'
import { buildLlmListener } from '../../src/llm/listener.js'
import { LlmMeter, type LlmReservation } from '../../src/llm/meter.js'
import type { LlmTokenCounter } from '../../src/llm/tokenizer.js'
import {
  type LlmAccountingScope,
  type LlmChatCompletion,
  type LlmChatRequest,
  type LlmCommittedUsageByModel,
  type LlmGrant,
  type LlmSuccessfulRecord,
  type ModelAlias,
  modelCostWeights,
} from '../../src/llm/types.js'
import { UpstreamError } from '../../src/llm/upstream.js'
import { configureAppLogs, createLogBuffer, resetAppLogs } from '../../src/logging/log-buffer.js'

const completion = (usage: unknown = null): OpenAI.Chat.Completions.ChatCompletion =>
  ({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'provider-secret',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: 'ok', refusal: null },
      },
    ],
    usage,
  }) as OpenAI.Chat.Completions.ChatCompletion

/** Aggregate the successful records a scope's sink stored, so admission reads them back. */
function committedUsage(records: readonly LlmSuccessfulRecord[]): LlmCommittedUsageByModel {
  const byModel: LlmCommittedUsageByModel = {}
  for (const record of records) {
    const usage = byModel[record.model] ?? {
      calls: 0,
      inputTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    }
    usage.calls += 1
    usage.inputTokens += record.usage.inputTokens
    usage.reasoningTokens += record.usage.reasoningTokens
    usage.outputTokens += record.usage.outputTokens
    byModel[record.model] = usage
  }
  return byModel
}

interface FixtureOptions {
  models?: LlmGrant['models']
  tokenBudget?: number
  rpm?: number
  sink?: LlmGrant['recordSink']
  tokenizer?: LlmTokenCounter
}

function fixture(overrides: FixtureOptions = {}) {
  const models: LlmGrant['models'] = overrides.models ?? {
    small: { upstream: 'provider-secret', costWeight: 1 },
  }
  const records: LlmSuccessfulRecord[] = []
  const scope: LlmAccountingScope = {
    key: 'session:s1:player_0',
    limits: { tokenBudget: overrides.tokenBudget ?? 100, requestsPerMinute: overrides.rpm ?? 10 },
    weights: modelCostWeights(models),
    readCommittedUsage: () => committedUsage(records),
  }
  const sink: LlmGrant['recordSink'] = async (record) => {
    await overrides.sink?.(record)
    records.push(record)
  }
  const grant = {
    kind: 'official',
    models,
    accountingScope: scope,
    recordSink: sink,
  } satisfies LlmGrant
  const tokenizer: LlmTokenCounter = overrides.tokenizer ?? {
    countRequest: () => 3,
    countCompletion: () => 5,
  }
  const upstream = {
    call: vi.fn(async (_request: LlmChatRequest, _signal?: AbortSignal) => ({
      completion: completion({
        prompt_tokens: 2,
        completion_tokens: 4,
        total_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 1 },
      }),
      latencyMs: 17,
    })),
  }
  const logs: string[] = []
  configureAppLogs(createLogBuffer({ sink: (message) => logs.push(message) }))
  const meter = new LlmMeter()
  const handler = new LlmHandler({
    meter,
    tokenizer,
    upstream,
    options: { defaultMaxOutputTokens: 8, maxOutputTokens: 20 },
  })
  return { grant, handler, logs, meter, records, upstream }
}

/** Build a listener and one official key for the common single-session setup. */
async function officialProxy(
  handler: LlmHandler,
  grant: LlmGrant,
  options: { now?: () => number; maxRequestMs?: number } = {},
) {
  const registry = new KeyRegistry(() => new Uint8Array(32).fill(7), options)
  const key = registry.issueOfficial(
    's1',
    { kind: 'official', models: grant.models, accountingScope: grant.accountingScope },
    createOfficialTickMarker(),
    () => grant.recordSink,
  )
  const app = await openListener({ registry, handler })
  return { app, key, registry }
}

const listeners: FastifyInstance[] = []
function gate() {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function openListener(deps: Parameters<typeof buildLlmListener>[0]) {
  const app = await buildLlmListener(deps)
  listeners.push(app)
  return app
}

function post(
  app: FastifyInstance,
  key: string,
  url = '/v1/chat/completions',
  payload: object = { model: 'small', messages: [] },
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    headers: { authorization: `Bearer ${key}`, ...headers },
  })
}

afterEach(async () => {
  await Promise.all(listeners.splice(0).map((app) => app.close()))
  resetAppLogs()
})

describe('LLM registry, handler, and listener', () => {
  it.each([
    ['small', 'provider-small', 1, 6],
    ['medium', 'provider-medium', 2, 12],
    ['large', 'provider-large', 4, 24],
    ['medium', 'provider-medium', 0.25, 1.5],
  ] as const)('forwards %s privately and records its canonical public completion once', async (tier, upstreamModel, costWeight, charge) => {
    const { grant, handler, records, upstream } = fixture({
      models: { [tier]: { upstream: upstreamModel, costWeight } },
    })
    const generated = `${upstreamModel} is literal generated content`
    const tool = {
      id: 'call-1',
      type: 'function' as const,
      function: { name: 'lookup', arguments: `{"model":"${upstreamModel}"}` },
    }
    const raw = completion({
      prompt_tokens: 2,
      completion_tokens: 4,
      total_tokens: 6,
      completion_tokens_details: { reasoning_tokens: 1 },
    })
    raw.choices = [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: generated,
          refusal: null,
          tool_calls: [tool],
        },
      },
    ]
    raw.moderation = {
      input: { code: 'moderation_skipped', message: 'input not moderated', type: 'error' },
      output: { model: upstreamModel, results: [{ model: upstreamModel, flagged: false }] },
    } as unknown as LlmChatCompletion['moderation']
    upstream.call.mockResolvedValueOnce({
      completion: {
        ...raw,
        model: upstreamModel,
        provider_metadata: { resolved_model: upstreamModel },
      } as LlmChatCompletion,
      latencyMs: 17,
    })
    const response = await handler.handle(grant, {
      model: tier,
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(upstream.call.mock.calls[0]?.[0]).toEqual({
      model: upstreamModel,
      messages: [{ role: 'user', content: 'hello' }],
      max_completion_tokens: 8,
    })
    expect(response.model).toBe(tier)
    expect(response.choices[0]?.message).toMatchObject({ content: generated, tool_calls: [tool] })
    expect(response.moderation).toEqual({
      input: { code: 'moderation_skipped', message: 'input not moderated', type: 'error' },
      output: { model: tier, results: [{ model: tier, flagged: false }] },
    })
    expect(response).not.toHaveProperty('provider_metadata')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: tier,
      costWeight,
      budgetCostUnits: charge,
      request: { model: tier, max_completion_tokens: 8 },
      usage: { inputTokens: 2, reasoningTokens: 1, outputTokens: 4 },
      usageEstimated: false,
      latencyMs: 17,
    })
    expect(records[0]?.completion).toEqual(response)
  })

  it.each([
    ['missing', null, 0],
    ['negative', { prompt_tokens: -1, completion_tokens: 4, total_tokens: 3 }, 0],
    ['non-integer', { prompt_tokens: 1.5, completion_tokens: 4, total_tokens: 5.5 }, 0],
    [
      'unsafe integer',
      {
        prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
        completion_tokens: 0,
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
      },
      0,
    ],
    ['inconsistent total', { prompt_tokens: 2, completion_tokens: 4, total_tokens: 99 }, 0],
    [
      'reasoning exceeds completion',
      {
        prompt_tokens: 2,
        completion_tokens: 4,
        total_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
      5,
    ],
  ] as const)('uses fallback estimates for %s usage without changing the completion', async (_label, usage, reasoningTokens) => {
    let countedRequest: Readonly<Record<string, unknown>> | undefined
    let countedCompletion: Readonly<Record<string, unknown>> | undefined
    const { grant, handler, records, upstream } = fixture({
      tokenizer: {
        countRequest: (value) => {
          countedRequest = value
          return 3
        },
        countCompletion: (value) => {
          countedCompletion = value
          return 5
        },
      },
    })
    upstream.call.mockResolvedValueOnce({
      completion: {
        ...completion(usage),
        provider_metadata: { resolved_model: 'provider-secret' },
      } as LlmChatCompletion,
      latencyMs: 2,
    })
    const response = await handler.handle(grant, { model: 'small', messages: [] })
    expect(response.usage).toEqual(usage)
    expect(response.model).toBe('small')
    expect(countedRequest).toEqual({ model: 'small', messages: [], max_completion_tokens: 8 })
    expect(countedCompletion).toEqual(response)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      costWeight: 1,
      budgetCostUnits: 8,
      usage: { inputTokens: 3, reasoningTokens, outputTokens: 5 },
      usageEstimated: true,
    })
  })

  it.each([
    [{ max_tokens: 7 }, { max_tokens: 7 }],
    [{ max_completion_tokens: 9 }, { max_completion_tokens: 9 }],
    [{}, { max_completion_tokens: 8 }],
    [{ max_tokens: 20 }, { max_tokens: 20 }],
  ])('forwards exactly one output maximum for %j', async (maximum, normalized) => {
    const { grant, handler, records, upstream } = fixture()
    await handler.handle(grant, { model: 'small', messages: [], stream: false, ...maximum })
    expect(upstream.call.mock.calls[0]?.[0]).toEqual({
      model: 'provider-secret',
      messages: [],
      stream: false,
      ...normalized,
    })
    expect(records).toHaveLength(1)
    expect(records[0]?.request).toEqual({
      model: 'small',
      messages: [],
      stream: false,
      ...normalized,
    })
  })

  it.each([
    [{ max_tokens: 7 }, 10, 9],
    [{ max_completion_tokens: 9 }, 12, 11],
    [{}, 11, 10],
  ])('reserves the output maximum in %j at the exact budget boundary', async (maximum, exactBudget, shortBudget) => {
    const exact = fixture({ tokenBudget: exactBudget })
    await expect(
      exact.handler.handle(exact.grant, {
        model: 'small',
        messages: [],
        ...maximum,
      }),
    ).resolves.toMatchObject({ model: 'small' })
    expect(exact.records).toHaveLength(1)
    const short = fixture({ tokenBudget: shortBudget })
    await expect(
      short.handler.handle(short.grant, {
        model: 'small',
        messages: [],
        ...maximum,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'budget_exceeded' })
    expect(short.upstream.call).not.toHaveBeenCalled()
    expect(short.records).toEqual([])
    await expect(
      short.handler.handle(short.grant, {
        model: 'small',
        messages: [],
        max_completion_tokens: 1,
      }),
    ).resolves.toMatchObject({ model: 'small' })
  })

  it('authenticates official keys and isolates tick markers between sessions', async () => {
    const { grant, handler, records, upstream } = fixture()
    let issued = 6
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(++issued))
    const tick = createOfficialTickMarker()
    const firstKey = registry.issueOfficial('s1', grant, tick, () => grant.recordSink)
    const secondKey = registry.issueOfficial('s1', grant, tick, () => grant.recordSink)
    const otherTick = createOfficialTickMarker()
    const otherGrant = {
      ...grant,
      accountingScope: { ...grant.accountingScope, key: 'session:s2:player_0' },
    } satisfies LlmGrant
    const otherKey = registry.issueOfficial(
      's2',
      otherGrant,
      otherTick,
      () => otherGrant.recordSink,
    )
    const app = await openListener({ registry, handler })

    for (const key of [firstKey, secondKey, otherKey]) {
      expect(key).toMatch(/^sk-sandbox-[0-9a-f]{64}$/)
    }
    const setup = await post(app, firstKey, '/internal/tick', { phase: 'setup' })
    expect(setup.statusCode).toBe(200)
    expect(tick.current).toBeNull()
    await post(app, firstKey, '/internal/tick', { tick: 12 })
    expect(tick.current).toBe(12)
    expect(otherTick.current).toBeNull()

    const invalidTick = await post(app, otherKey, '/internal/tick', { tick: -1 })
    expect(invalidTick.statusCode).toBe(400)
    expect(invalidTick.json()).toMatchObject({ error: { code: 'invalid_tick_marker' } })
    expect(otherTick.current).toBeNull()
    await post(app, otherKey, '/internal/tick', { tick: 3 })
    expect(otherTick.current).toBe(3)
    expect(tick.current).toBe(12)

    const accepted = await post(app, secondKey)
    expect(accepted.statusCode).toBe(200)
    expect(records).toHaveLength(1)
    expect(records[0]).not.toHaveProperty('tick')
    expect(records[0]).not.toHaveProperty('admissionTick')

    await registry.revokeSession('s1')
    for (const key of [firstKey, secondKey]) {
      const denied = await post(app, key)
      expect(denied.statusCode).toBe(401)
      expect(denied.json()).toMatchObject({ error: { code: 'invalid_api_key' } })
    }
    const stillAccepted = await post(app, otherKey)
    expect(stillAccepted.statusCode).toBe(200)
    expect(records).toHaveLength(2)
    expect(upstream.call).toHaveBeenCalledTimes(2)
  })

  it('closes admission immediately and drains through durable finalization', async () => {
    const started = gate()
    const finish = gate()
    const { grant, handler, records } = fixture({
      sink: async () => {
        started.resolve()
        await finish.promise
      },
    })
    const { app, key, registry } = await officialProxy(handler, grant)
    try {
      let responded = false
      const pending = post(app, key).then((response) => {
        responded = true
        expect(records).toHaveLength(1)
        return response
      })
      await started.promise
      let settled = 0
      const first = registry.revokeSession('s1').then(() => {
        settled++
      })
      const second = registry.revokeSession('s1').then(() => {
        settled++
      })
      expect((await post(app, key)).statusCode).toBe(401)
      expect((await post(app, key, '/internal/tick', { tick: 9 })).statusCode).toBe(401)
      expect(settled).toBe(0)
      expect(responded).toBe(false)
      expect(records).toEqual([])
      finish.resolve()
      expect((await pending).statusCode).toBe(200)
      await Promise.all([first, second])
      expect(settled).toBe(2)
    } finally {
      finish.resolve()
    }
  })

  it('aborts pre-success work and releases accounting on cancellation', async () => {
    let markStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const { grant, handler, records, upstream } = fixture({ tokenBudget: 11, rpm: 1 })
    upstream.call.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          markStarted()
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const { app, key, registry } = await officialProxy(handler, grant)

    const activeRequest = post(app, key)
    await started
    await registry.revokeSession('s1')

    const response = await activeRequest
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'request_cancelled' } })
    expect(records).toHaveLength(0)

    const probe = await handler.handle(grant, { model: 'small', messages: [] })
    expect(probe.model).toBe('small')
    expect(records).toHaveLength(1)
    expect(upstream.call).toHaveBeenCalledTimes(2)

    const denied = await post(app, key)
    expect(denied.statusCode).toBe(401)
    expect(denied.json()).toMatchObject({ error: { code: 'invalid_api_key' } })
  })

  it('counts success, failure and background time with exact background watchdog exclusion', async () => {
    let now = 1_000
    const { grant, handler, upstream } = fixture()
    upstream.call
      .mockImplementationOnce(async () => {
        now = 1_040
        return { completion: completion(), latencyMs: 40 }
      })
      .mockImplementationOnce(async () => {
        now = 1_065
        throw new LlmError(400, 'bad_upstream', 'bad')
      })
      .mockImplementationOnce(async () => {
        now = 1_075
        return { completion: completion(), latencyMs: 10 }
      })
      .mockImplementationOnce(async () => {
        now = 1_085
        return { completion: completion(), latencyMs: 10 }
      })
    const { app, key, registry } = await officialProxy(handler, grant, { now: () => now })
    for (const [headers, status, total, blocking] of [
      [{}, 200, 40, 40],
      [{}, 400, 65, 65],
      [{ 'x-game-sandbox-background': '1' }, 200, 75, 65],
      [{ 'x-game-sandbox-background': 'true' }, 200, 85, 75],
    ] as const) {
      expect((await post(app, key, '/v1/chat/completions', undefined, headers)).statusCode).toBe(
        status,
      )
      expect((await post(app, key, '/internal/inflight')).json()).toEqual({ inflight_ms: total })
      expect(registry.blockingInFlightMs('s1')).toBe(blocking)
    }
  })

  it('reads capped active partials by scope through the inflight route', async () => {
    let now = 1_000
    let issued = 10
    const { grant, handler } = fixture()
    const otherGrant = {
      ...grant,
      accountingScope: { ...grant.accountingScope, key: 'session:s2:player_0' },
    } satisfies LlmGrant
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(++issued), {
      now: () => now,
      maxRequestMs: 15,
    })
    const firstKey = registry.issueOfficial(
      's1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const secondKey = registry.issueOfficial(
      's1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const otherKey = registry.issueOfficial(
      's2',
      otherGrant,
      createOfficialTickMarker(),
      () => otherGrant.recordSink,
    )
    const first = registry.authenticateRequest(firstKey)
    const second = registry.authenticateRequest(secondKey)
    const other = registry.authenticateRequest(otherKey)
    const app = await openListener({ registry, handler })

    now = 1_050
    const own = await post(app, firstKey, '/internal/inflight')
    expect(own.json()).toEqual({ inflight_ms: 30 })
    const sibling = await post(app, otherKey, '/internal/inflight')
    expect(sibling.json()).toEqual({ inflight_ms: 15 })
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(30)
    expect(registry.blockingInFlightMs('s1')).toBe(30)

    first.release()
    const afterRelease = await post(app, secondKey, '/internal/inflight')
    expect(afterRelease.json()).toEqual({ inflight_ms: 30 })

    const revocation = registry.revokeSession('s1')
    second.release()
    await revocation
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(0)
    expect(registry.blockingInFlightMs('s1')).toBe(0)
    const liveScope = await post(app, otherKey, '/internal/inflight')
    expect(liveScope.json()).toEqual({ inflight_ms: 15 })
    const retired = await post(app, firstKey, '/internal/inflight')
    expect(retired.statusCode).toBe(401)

    other.release()
    await registry.revokeSession('s2')
    expect(registry.inFlightMsForScope(otherGrant.accountingScope.key)).toBe(0)
  })

  it.each([
    undefined,
    'Basic abc',
    'Bearer',
    'Bearer one two',
    `Bearer sk-sandbox-${'a'.repeat(64)}`,
  ])('returns a compatible authentication envelope for authorization %s', async (authorization) => {
    const { grant, handler, records, upstream } = fixture()
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(1))
    registry.issueOfficial('s1', grant, createOfficialTickMarker(), () => grant.recordSink)
    const app = await openListener({ registry, handler })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      ...(authorization === undefined ? {} : { headers: { authorization } }),
      payload: { model: 'small', messages: [] },
    })
    expect(response.statusCode).toBe(401)
    const body = response.json()
    expect(body.error.code).toBe('invalid_api_key')
    expect(body.error.type).toBe('invalid_request_error')
    expect(body.error.message.length).toBeGreaterThan(0)
    expect(upstream.call).not.toHaveBeenCalled()
    expect(records).toHaveLength(0)
  })

  it('normalizes malformed JSON and unknown routes without leaking request content', async () => {
    const { handler, logs, records, upstream } = fixture()
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(1))
    const app = await openListener({ registry, handler })
    const secret = 'sk-live-synthetic-4f9a'
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: `{"authorization":"Bearer ${secret}"`,
    })
    expect(malformed.statusCode).toBe(400)
    const malformedBody = malformed.json()
    expect(malformedBody.error.code).toBe('invalid_request')
    expect(malformedBody.error.type).toBe('invalid_request_error')
    expect(malformedBody.error.message.length).toBeGreaterThan(0)
    const diagnostics = logs.join('\n')
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics.toLowerCase()).toContain('malformed')
    expect(diagnostics).not.toContain(secret)

    const wrongMethod = await app.inject({ method: 'GET', url: '/v1/chat/completions' })
    expect(wrongMethod.statusCode).toBe(404)
    const wrongBody = wrongMethod.json()
    expect(wrongBody.error.code).toBe('not_found')
    expect(wrongBody.error.type).toBe('invalid_request_error')
    expect(wrongBody.error.message.length).toBeGreaterThan(0)
    expect(upstream.call).not.toHaveBeenCalled()
    expect(records).toHaveLength(0)
  })

  it('redacts the configured upstream model from terminal error fields', async () => {
    const { grant, handler, upstream } = fixture()
    upstream.call.mockRejectedValueOnce(
      new UpstreamError(400, {
        error: {
          message: 'provider-secret is unavailable',
          type: 'provider-secret_error',
          code: 'provider-secret_missing',
        },
      }),
    )
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      status: 400,
      envelope: {
        error: {
          message: 'small is unavailable',
          type: 'small_error',
          code: 'small_missing',
        },
      },
    })
  })

  it('refuses disabled aliases, streaming and invalid output maxima before provider spend', async () => {
    const { grant, handler, upstream, records } = fixture()
    for (const [body, code] of [
      [{ model: 'large' }, 'model_not_allowed'],
      [{ model: 'toString' }, 'model_not_allowed'],
      ...[true, 'false', 0, null].map((stream) => [{ stream }, 'streaming_unsupported'] as const),
      [{ max_tokens: 1, max_completion_tokens: 1 }, 'invalid_max_tokens'],
      ...[21, -1, 1.5, '2'].map((max_tokens) => [{ max_tokens }, 'invalid_max_tokens'] as const),
      [{ max_tokens: Number.NaN }, 'invalid_max_tokens'],
    ] as const) {
      await expect(
        handler.handle(grant, { model: 'small', messages: [], ...body }),
      ).rejects.toMatchObject({ status: 400, code })
    }
    expect(upstream.call).not.toHaveBeenCalled()
    expect(records).toEqual([])
  })
})

describe('generic admission and unavailable scopes', () => {
  interface WeightedBudgetCase {
    label: string
    limits: { tokenBudget: number; requestsPerMinute: number }
    weights: Partial<Record<ModelAlias, number>>
    committed: LlmCommittedUsageByModel
    admitted: readonly [ModelAlias, number, number]
    refused: readonly [ModelAlias, number, number]
  }

  const weightedBudgetCases: WeightedBudgetCase[] = [
    {
      label: 'mixed weights at the exact boundary',
      limits: { tokenBudget: 20, requestsPerMinute: 10 },
      weights: { large: 4, medium: 2, small: 1 },
      committed: {
        small: { calls: 1, inputTokens: 1, reasoningTokens: 0, outputTokens: 1 },
        medium: { calls: 1, inputTokens: 1, reasoningTokens: 0, outputTokens: 2 },
      },
      admitted: ['large', 1, 2],
      refused: ['small', 0, 1],
    },
    {
      label: 'a fractional weight at the exact boundary without rounding',
      limits: { tokenBudget: 10, requestsPerMinute: 10 },
      weights: { small: 0.25 },
      committed: { small: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 3 } },
      admitted: ['small', 17, 18],
      refused: ['small', 0, 1],
    },
    {
      label: 'reasoning inside committed output',
      limits: { tokenBudget: 8, requestsPerMinute: 10 },
      weights: { small: 1 },
      committed: { small: { calls: 1, inputTokens: 2, reasoningTokens: 3, outputTokens: 5 } },
      admitted: ['small', 0, 1],
      refused: ['small', 0, 1],
    },
    ...(['retired', 'constructor', '__proto__'] as const).map((alias) => ({
      label: `unknown committed alias ${alias} uses the highest current price`,
      limits: { tokenBudget: 12, requestsPerMinute: 10 },
      weights: { medium: 2, small: 1 },
      committed: { [alias]: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 3 } },
      admitted: ['small', 1, 1] as const,
      refused: ['small', 0, 1] as const,
    })),
  ]

  const faultCases: Array<{
    label: string
    tokenizer: LlmTokenCounter
    faulty: LlmChatCompletion
  }> = [
    {
      label: 'estimation',
      tokenizer: {
        countRequest: () => 3,
        countCompletion: () => {
          throw new Error('estimator failed')
        },
      },
      faulty: completion(null),
    },
    {
      label: 'canonicalization',
      tokenizer: { countRequest: () => 3, countCompletion: () => 5 },
      faulty: {
        ...completion({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }),
        moderation: {
          input: { model: 'provider-secret', results: null },
          output: { model: 'provider-secret', results: [] },
        },
      } as unknown as LlmChatCompletion,
    },
  ]

  it.each([
    ['token', { tokenBudget: 10, requestsPerMinute: 10 }, 3, 3, 'budget_exceeded'],
    ['rate', { tokenBudget: 100, requestsPerMinute: 1 }, 2, 3, 'rate_limit_exceeded'],
  ] as const)('makes concurrent %s reservations observe one atomic budget', async (kind, limits, input, output, refusalCode) => {
    const meter = new LlmMeter()
    const scope: LlmAccountingScope = {
      key: `concurrent:${kind}`,
      limits,
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const outcomes = await Promise.allSettled([
      meter.reserve(scope, 'small', input, output),
      meter.reserve(scope, 'small', input, output),
    ])
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: refusalCode } })
    const accepted = outcomes.find((outcome) => outcome.status === 'fulfilled')
    if (accepted?.status !== 'fulfilled') throw new Error('expected one admitted reservation')
    meter.release(accepted.value)

    const fresh = await meter.reserve(scope, 'small', input, output)
    meter.release(fresh)
  })

  it.each(weightedBudgetCases)('$label', async (weightedCase) => {
    const meter = new LlmMeter()
    const scope: LlmAccountingScope = {
      key: 'weighted:case',
      limits: weightedCase.limits,
      weights: weightedCase.weights,
      readCommittedUsage: () => weightedCase.committed,
    }
    const held = await meter.reserve(scope, ...weightedCase.admitted)
    await expect(meter.reserve(scope, ...weightedCase.refused)).rejects.toMatchObject({
      code: 'budget_exceeded',
    })
    meter.release(held)

    const recovered = await meter.reserve(scope, ...weightedCase.admitted)
    meter.release(recovered)
  })

  it.each([
    ['token', { tokenBudget: 2, requestsPerMinute: 10 }, 'budget_exceeded'],
    ['rate', { tokenBudget: 100, requestsPerMinute: 1 }, 'rate_limit_exceeded'],
  ] as const)('isolates pending %s capacity for official players and development keys', async (_name, limits, code) => {
    const meter = new LlmMeter()
    const scopes = [
      'session:s1:player_0',
      'session:s1:player_1',
      'development:participant-1:season-1',
    ].map(
      (key): LlmAccountingScope => ({
        key,
        limits,
        weights: { small: 1 },
        readCommittedUsage: () => ({}),
      }),
    )
    const reservations = []
    for (const scope of scopes) {
      reservations.push(await meter.reserve(scope, 'small', 1, 1))
      await expect(meter.reserve(scope, 'small', 1, 1)).rejects.toMatchObject({ code })
    }
    for (const reservation of reservations) meter.release(reservation)
    for (const scope of scopes) {
      const retry = await meter.reserve(scope, 'small', 1, 1)
      meter.release(retry)
    }
  })

  it('keeps admission order when overlapping requests finish in reverse', async () => {
    let now = 1_000
    const meter = new LlmMeter({ now: () => now })
    const scope: LlmAccountingScope = {
      key: 'concurrent:rate-order',
      limits: { tokenBudget: 100, requestsPerMinute: 2 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const first = await meter.reserve(scope, 'small', 1, 0)
    now = 1_010
    const second = await meter.reserve(scope, 'small', 1, 0)

    now = 1_020
    meter.recordRateEvent(second)
    meter.release(second)
    meter.recordRateEvent(first)
    meter.release(first)

    now = 60_999
    await expect(meter.reserve(scope, 'small', 1, 0)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    now = 61_000
    const atFirstExpiry = await meter.reserve(scope, 'small', 1, 0)
    now = 61_009
    await expect(meter.reserve(scope, 'small', 1, 0)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    now = 61_010
    const atSecondExpiry = await meter.reserve(scope, 'small', 1, 0)

    meter.release(atFirstExpiry)
    meter.release(atSecondExpiry)
  })

  it('keeps a later success when an earlier concurrent request fails', async () => {
    let now = 1_000
    const meter = new LlmMeter({ now: () => now })
    const scope: LlmAccountingScope = {
      key: 'concurrent:rate-rollback',
      limits: { tokenBudget: 100, requestsPerMinute: 2 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const earlier = await meter.reserve(scope, 'small', 1, 0)
    now = 1_010
    const later = await meter.reserve(scope, 'small', 1, 0)

    now = 1_020
    meter.recordRateEvent(later)
    meter.release(later)
    meter.release(earlier)

    const reusable = await meter.reserve(scope, 'small', 1, 0)
    await expect(meter.reserve(scope, 'small', 1, 0)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    meter.release(reusable)
  })

  it.each([
    ['without an intervening admission', false],
    ['with an intervening admission', true],
  ] as const)('expires a pending start at the window boundary %s', async (_label, intervening) => {
    let now = 1_000
    const meter = new LlmMeter({ now: () => now })
    const scope: LlmAccountingScope = {
      key: 'concurrent:rate-expiry',
      limits: { tokenBudget: 100, requestsPerMinute: 1 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const slow = await meter.reserve(scope, 'small', 1, 0)

    now = 60_999
    await expect(meter.reserve(scope, 'small', 1, 0)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })

    now = 61_000
    let current: LlmReservation
    if (intervening) {
      current = await meter.reserve(scope, 'small', 1, 0)
      meter.recordRateEvent(slow)
      meter.release(slow)
    } else {
      meter.recordRateEvent(slow)
      meter.release(slow)
      current = await meter.reserve(scope, 'small', 1, 0)
    }

    await expect(meter.reserve(scope, 'small', 1, 0)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    meter.release(current)
  })

  it('releases token and rate capacity after a terminal upstream failure', async () => {
    const { grant, handler, records, upstream } = fixture({ tokenBudget: 11, rpm: 1 })
    upstream.call.mockRejectedValueOnce(new LlmError(400, 'bad_upstream', 'bad'))
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'bad_upstream',
    })
    expect(records).toHaveLength(0)

    const response = await handler.handle(grant, { model: 'small', messages: [] })
    expect(response.model).toBe('small')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ budgetCostUnits: 6, usageEstimated: false })
    expect(upstream.call).toHaveBeenCalledTimes(2)
  })

  it('limits the next call once the successful-call rate window is full at rpm one', async () => {
    const { grant, handler, records, upstream } = fixture({ rpm: 1 })
    const response = await handler.handle(grant, { model: 'small', messages: [] })
    expect(response.model).toBe('small')
    expect(records).toHaveLength(1)

    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    expect(upstream.call).toHaveBeenCalledTimes(1)
    expect(records).toHaveLength(1)
  })

  it('keeps a failed durable sink unavailable while another scope remains usable', async () => {
    const { grant, handler, upstream, records } = fixture({
      sink: () => {
        throw new Error('disk full')
      },
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
        status: 503,
        code: 'meter_unavailable',
        type: expect.stringMatching(/\S/),
        message: expect.stringMatching(/\S/),
      })
    }
    expect(upstream.call).toHaveBeenCalledTimes(1)
    expect(records).toEqual([])
    const other = {
      ...grant,
      accountingScope: { ...grant.accountingScope, key: 'development:other' },
      recordSink: (record: LlmSuccessfulRecord) => {
        records.push(record)
      },
    }
    await expect(handler.handle(other, { model: 'small', messages: [] })).resolves.toMatchObject({
      model: 'small',
    })
    expect(records).toHaveLength(1)
  })

  it.each(
    faultCases,
  )('recovers after a $label fault and retains provider-success rate usage', async ({
    tokenizer,
    faulty,
  }) => {
    const { grant, handler, logs, records, upstream } = fixture({
      tokenBudget: 17,
      rpm: 2,
      tokenizer,
    })
    upstream.call.mockResolvedValueOnce({ completion: faulty, latencyMs: 1 })
    const { app, key } = await officialProxy(handler, grant)
    const secret = 'fault-payload-4f9a'
    const payload = { model: 'small', messages: [{ role: 'user', content: secret }] }
    const faulted = await post(app, key, '/v1/chat/completions', payload)
    expect(faulted.statusCode).toBe(500)
    expect(faulted.json()).toEqual({
      error: { code: 'internal_error', type: 'server_error', message: expect.stringMatching(/\S/) },
    })
    expect(records).toEqual([])
    expect(logs.join('\n')).toContain(grant.accountingScope.key)
    expect(logs.join('\n')).toMatch(/small.*(spend|account)/)
    expect(logs.join('\n')).not.toContain(secret)
    expect((await post(app, key, '/v1/chat/completions', payload)).statusCode).toBe(200)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      budgetCostUnits: 6,
      usage: { inputTokens: 2, reasoningTokens: 1, outputTokens: 4 },
      usageEstimated: false,
    })
    const refused = await post(app, key, '/v1/chat/completions', payload)
    expect(refused.statusCode).toBe(429)
    expect(refused.json()).toMatchObject({
      error: { code: 'rate_limit_exceeded', type: 'rate_limit_error' },
    })
    expect(upstream.call).toHaveBeenCalledTimes(2)
  })
})
