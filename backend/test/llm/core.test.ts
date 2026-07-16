import type OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmError } from '../../src/llm/errors.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { createOfficialTickMarker, KeyRegistry } from '../../src/llm/key-registry.js'
import { buildLlmListener } from '../../src/llm/listener.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { LlmTokenCounter } from '../../src/llm/tokenizer.js'
import {
  emptyUsage,
  type LlmAccountingScope,
  type LlmChatRequest,
  type LlmGrant,
  type LlmSuccessfulRecord,
} from '../../src/llm/types.js'
import { UpstreamError } from '../../src/llm/upstream.js'

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

function fixture(
  overrides: { rpm?: number; sink?: LlmGrant['recordSink']; tokenizer?: LlmTokenCounter } = {},
) {
  const records: LlmSuccessfulRecord[] = []
  const scope: LlmAccountingScope = {
    key: 'session:s1:player_0',
    limits: { tokenBudget: 100, callBudget: 10, requestsPerMinute: overrides.rpm ?? 10 },
    readCommittedUsage: emptyUsage,
  }
  const sink =
    overrides.sink ??
    ({
      record: (record) => {
        records.push(record)
      },
      probeHealth: () => {},
    } satisfies LlmGrant['recordSink'])
  const grant: LlmGrant = {
    kind: 'official',
    models: { small: 'provider-secret' },
    accountingScopes: [scope],
    recordSink: sink,
  }
  const tokenizer: LlmTokenCounter = overrides.tokenizer ?? {
    countRequest: () => 3,
    countCompletion: () => 5,
  }
  const upstream = {
    call: vi.fn(async (_request: LlmChatRequest) => ({
      completion: completion({
        prompt_tokens: 2,
        completion_tokens: 4,
        total_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 1 },
      }),
      latencyMs: 17,
    })),
  }
  const meter = new LlmMeter({ recoveryIntervalMs: 10 })
  const handler = new LlmHandler({
    meter,
    tokenizer,
    upstream,
    options: { defaultMaxOutputTokens: 8, maxOutputTokens: 20 },
  })
  return { grant, handler, meter, records, tokenizer, upstream }
}

describe('LLM registry, handler, and listener', () => {
  it('maps aliases both ways, normalizes the output maximum, and records once before success', async () => {
    const { grant, handler, records, upstream } = fixture()
    const upstreamCompletion = completion({
      prompt_tokens: 2,
      completion_tokens: 4,
      total_tokens: 6,
      completion_tokens_details: { reasoning_tokens: 1 },
    })
    const firstChoice = upstreamCompletion.choices[0]
    if (firstChoice !== undefined) {
      firstChoice.message.content = 'provider-secret is literal generated content'
    }
    upstreamCompletion.moderation = {
      input: { code: 'moderation_skipped', message: 'input not moderated', type: 'error' },
      output: { code: 'moderation_skipped', message: 'output not moderated', type: 'error' },
    }
    upstream.call.mockResolvedValueOnce({
      completion: {
        ...upstreamCompletion,
        provider_metadata: { resolved_model: 'provider-secret' },
      } as OpenAI.Chat.Completions.ChatCompletion,
      latencyMs: 17,
    })
    const response = await handler.handle(grant, {
      model: 'small',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(upstream.call).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'provider-secret', max_completion_tokens: 8 }),
    )
    expect(response.model).toBe('small')
    expect(response.choices[0]?.message.content).toBe(
      'provider-secret is literal generated content',
    )
    expect(response.moderation).toEqual(upstreamCompletion.moderation)
    expect(response).not.toHaveProperty('provider_metadata')
    expect(records).toHaveLength(1)
    expect(records[0]?.completion).not.toHaveProperty('provider_metadata')
    expect(records[0]).toMatchObject({
      model: 'small',
      request: { model: 'small', max_completion_tokens: 8 },
      completion: { model: 'small' },
      usage: { inputTokens: 2, reasoningTokens: 1, outputTokens: 4 },
      usageEstimated: false,
      latencyMs: 17,
    })
  })

  it.each([
    ['missing', null],
    ['negative', { prompt_tokens: -1, completion_tokens: 4, total_tokens: 3 }],
    ['non-integer', { prompt_tokens: 1.5, completion_tokens: 4, total_tokens: 5.5 }],
    [
      'unsafe integer',
      {
        prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
        completion_tokens: 0,
        total_tokens: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    ['inconsistent total', { prompt_tokens: 2, completion_tokens: 4, total_tokens: 99 }],
    [
      'reasoning exceeds completion',
      {
        prompt_tokens: 2,
        completion_tokens: 4,
        total_tokens: 6,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    ],
  ])('uses fallback estimates for %s usage without changing the completion', async (name, usage) => {
    const { grant, handler, records, upstream } = fixture()
    upstream.call.mockResolvedValueOnce({ completion: completion(usage), latencyMs: 2 })
    const response = await handler.handle(grant, { model: 'small', messages: [] })
    expect(response.usage).toEqual(usage)
    expect(records[0]).toMatchObject({
      usage: {
        inputTokens: 3,
        reasoningTokens: name === 'reasoning exceeds completion' ? 5 : 0,
        outputTokens: 5,
      },
      usageEstimated: true,
    })
  })

  it('forwards explicit max_tokens unchanged and injects the modern default only when absent', async () => {
    const { grant, handler, upstream } = fixture()
    await handler.handle(grant, { model: 'small', messages: [], max_tokens: 7 })
    await handler.handle(grant, { model: 'small', messages: [] })
    expect(upstream.call.mock.calls[0]?.[0]).toMatchObject({ max_tokens: 7 })
    expect(upstream.call.mock.calls[0]?.[0]).not.toHaveProperty('max_completion_tokens')
    expect(upstream.call.mock.calls[1]?.[0]).toMatchObject({ max_completion_tokens: 8 })
    expect(upstream.call.mock.calls[1]?.[0]).not.toHaveProperty('max_tokens')
    await handler.handle(grant, { model: 'small', messages: [], stream: false })
    expect(upstream.call.mock.calls[2]?.[0]).toMatchObject({ stream: false })
  })

  it('authenticates and revokes official keys and isolates their tick markers', async () => {
    const { grant, handler, upstream } = fixture()
    let issued = 6
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(++issued))
    const tick = createOfficialTickMarker()
    const key = registry.issueOfficial('s1', grant, tick)
    const otherTick = createOfficialTickMarker()
    const otherKey = registry.issueOfficial('s2', grant, otherTick)
    const app = await buildLlmListener({ registry, handler })

    expect(key).toMatch(/^sk-sandbox-[0-9a-f]{64}$/)
    const setup = await app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: { authorization: `Bearer ${key}` },
      payload: { phase: 'setup' },
    })
    expect(setup.statusCode).toBe(200)
    expect(tick.current).toBeNull()
    await app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: { authorization: `Bearer ${key}` },
      payload: { tick: 12 },
    })
    expect(tick.current).toBe(12)
    expect(otherTick.current).toBeNull()

    const invalidTick = await app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: { authorization: `Bearer ${otherKey}` },
      payload: { tick: -1 },
    })
    expect(invalidTick.statusCode).toBe(400)
    expect(invalidTick.json()).toMatchObject({ error: { code: 'invalid_tick_marker' } })
    expect(otherTick.current).toBeNull()
    await app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: { authorization: `Bearer ${otherKey}` },
      payload: { tick: 3 },
    })
    expect(otherTick.current).toBe(3)
    expect(tick.current).toBe(12)

    registry.revokeSession('s1')
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(denied.statusCode).toBe(401)
    expect(denied.json()).toMatchObject({ error: { code: 'invalid_api_key' } })
    expect(upstream.call).not.toHaveBeenCalled()
    await app.close()
  })

  it.each([
    undefined,
    'Basic abc',
    'Bearer',
    'Bearer one two',
  ])('returns the pinned authentication envelope for malformed authorization %s', async (authorization) => {
    const { grant, handler, upstream } = fixture()
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(1))
    registry.issueOfficial('s1', grant, createOfficialTickMarker())
    const app = await buildLlmListener({ registry, handler })
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      ...(authorization === undefined ? {} : { headers: { authorization } }),
      payload: { model: 'small', messages: [] },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({
      error: {
        message: 'A valid bearer API key is required.',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    })
    expect(upstream.call).not.toHaveBeenCalled()
    await app.close()
  })

  it('uses fixed parse logging and compatible envelopes for malformed JSON and unknown methods', async () => {
    const { handler } = fixture()
    const log = vi.fn()
    const app = await buildLlmListener({
      registry: new KeyRegistry(() => new Uint8Array(32).fill(1)),
      handler,
      log,
    })
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ error: { code: 'invalid_request' } })
    expect(log).toHaveBeenCalledWith('LLM listener rejected malformed request')

    const wrongMethod = await app.inject({ method: 'GET', url: '/v1/chat/completions' })
    expect(wrongMethod.statusCode).toBe(404)
    expect(wrongMethod.json()).toEqual({
      error: {
        message: 'The requested LLM route was not found.',
        type: 'invalid_request_error',
        code: 'not_found',
      },
    })
    await app.close()
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

  it('rejects alias, streaming, malformed maxima, and hard-cap violations locally', async () => {
    const { grant, handler, upstream } = fixture()
    const cases = [
      [{ model: 'large', messages: [] }, 'model_not_allowed'],
      [{ model: 'toString', messages: [] }, 'model_not_allowed'],
      [{ model: 'small', messages: [], stream: true }, 'streaming_unsupported'],
      [{ model: 'small', messages: [], stream: 'false' }, 'streaming_unsupported'],
      [{ model: 'small', messages: [], stream: 0 }, 'streaming_unsupported'],
      [{ model: 'small', messages: [], stream: null }, 'streaming_unsupported'],
      [
        { model: 'small', messages: [], max_tokens: 1, max_completion_tokens: 1 },
        'invalid_max_tokens',
      ],
      [{ model: 'small', messages: [], max_tokens: 21 }, 'invalid_max_tokens'],
    ] as const
    for (const [body, code] of cases) {
      await expect(handler.handle(grant, body)).rejects.toMatchObject({ code })
    }
    expect(upstream.call).not.toHaveBeenCalled()
  })
})

describe('generic admission and recovery', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['call', { tokenBudget: 100, callBudget: 1, requestsPerMinute: 10 }, 2, 3],
    ['token', { tokenBudget: 10, callBudget: 10, requestsPerMinute: 10 }, 3, 3],
  ])('makes concurrent %s reservations observe one atomic budget', async (_kind, limits, input, output) => {
    const meter = new LlmMeter({ recoveryIntervalMs: 10 })
    const accountingScope: LlmAccountingScope = {
      key: `concurrent:${_kind}`,
      limits,
      readCommittedUsage: emptyUsage,
    }
    const outcomes = await Promise.allSettled([
      meter.reserve([accountingScope], input, output),
      meter.reserve([accountingScope], input, output),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'budget_exceeded' } })
    expect(meter.inspect(accountingScope.key)).toMatchObject({
      reservedCalls: 1,
      reservedTokens: input + output,
    })
    const accepted = outcomes.find((outcome) => outcome.status === 'fulfilled')
    if (accepted?.status === 'fulfilled') meter.release(accepted.value)
  })

  it('keeps multi-scope official and development-shaped accounting keys independent', async () => {
    const meter = new LlmMeter({ recoveryIntervalMs: 10 })
    const makeScope = (key: string): LlmAccountingScope => ({
      key,
      limits: { tokenBudget: 100, callBudget: 10, requestsPerMinute: 1 },
      readCommittedUsage: emptyUsage,
    })
    const sessionA = makeScope('session:s1:player_0')
    const runA = makeScope('run:r1:submission-a')
    const sessionB = makeScope('session:s1:player_1')
    const runB = makeScope('run:r1:submission-b')
    const development = makeScope('development:participant-1:season-1')

    const reservations = await Promise.all([
      meter.reserve([sessionA, runA], 1, 1),
      meter.reserve([sessionB, runB], 1, 1),
      meter.reserve([development], 1, 1),
    ])
    for (const scope of [sessionA, runA, sessionB, runB, development]) {
      expect(meter.inspect(scope.key)).toMatchObject({
        rateEvents: [expect.any(Number)],
        reservedCalls: 1,
      })
    }
    await expect(meter.reserve([development], 1, 1)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    expect(meter.inspect(sessionB.key).rateEvents).toHaveLength(1)
    for (const reservation of reservations) meter.release(reservation)
  })

  it('keeps one rate event after terminal upstream failure while releasing call/token reservation', async () => {
    const { grant, handler, meter, upstream } = fixture({ rpm: 1 })
    upstream.call.mockRejectedValueOnce(new LlmError(400, 'bad_upstream', 'bad'))
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'bad_upstream',
    })
    expect(meter.inspect(grant.accountingScopes[0]?.key ?? '').reservedCalls).toBe(0)
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    expect(upstream.call).toHaveBeenCalledTimes(1)
  })

  it('moves a failed record reservation to debt and closes the breaker only after health recovers', async () => {
    vi.useFakeTimers()
    let healthy = false
    const sink = {
      record: vi.fn(() => {
        throw new Error('disk full')
      }),
      probeHealth: vi.fn(() => {
        if (!healthy) throw new Error('still full')
      }),
    }
    const { grant, handler, meter, upstream } = fixture({ sink })
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'meter_unavailable',
    })
    const key = grant.accountingScopes[0]?.key ?? ''
    expect(meter.inspect(key)).toMatchObject({
      breakerOpen: true,
      reservedCalls: 0,
      debt: { calls: 1 },
    })
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'meter_unavailable',
    })
    expect(upstream.call).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10)
    expect(sink.probeHealth).toHaveBeenCalledTimes(1)
    expect(meter.inspect(key).breakerOpen).toBe(true)
    healthy = true
    await vi.advanceTimersByTimeAsync(10)
    expect(sink.probeHealth).toHaveBeenCalledTimes(2)
    expect(meter.inspect(key).breakerOpen).toBe(false)
    expect(meter.inspect(key).debt.calls).toBe(1)
    const accountingScope = grant.accountingScopes[0] as LlmAccountingScope
    accountingScope.limits.callBudget = 1
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'budget_exceeded',
    })
    expect(upstream.call).toHaveBeenCalledTimes(1)
  })

  it('retains debt and opens the breaker when estimation fails after upstream success', async () => {
    vi.useFakeTimers()
    const sink = { record: vi.fn(), probeHealth: vi.fn() }
    const tokenizer: LlmTokenCounter = {
      countRequest: () => 3,
      countCompletion: () => {
        throw new Error('estimator failed')
      },
    }
    const { grant, handler, meter, upstream } = fixture({ sink, tokenizer })
    upstream.call.mockResolvedValueOnce({ completion: completion(null), latencyMs: 1 })

    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'meter_unavailable',
    })

    const key = grant.accountingScopes[0]?.key ?? ''
    expect(sink.record).not.toHaveBeenCalled()
    expect(meter.inspect(key)).toMatchObject({
      breakerOpen: true,
      reservedCalls: 0,
      reservedTokens: 0,
      debt: { calls: 1, inputTokens: 3, outputTokens: 8 },
    })
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'meter_unavailable',
    })
    expect(upstream.call).toHaveBeenCalledOnce()
    meter.close()
  })

  it('opens every scope breaker and charges conservative token debt after one sink failure', async () => {
    vi.useFakeTimers()
    const sink = {
      record: vi.fn(() => {
        throw new Error('disk full')
      }),
      probeHealth: vi.fn(() => {
        throw new Error('still full')
      }),
    }
    const { grant, handler, meter } = fixture({ sink })
    const secondScope: LlmAccountingScope = {
      key: 'run:r1:submission-1',
      limits: { tokenBudget: 100, callBudget: 10, requestsPerMinute: 10 },
      readCommittedUsage: emptyUsage,
    }
    grant.accountingScopes.push(secondScope)

    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'meter_unavailable',
    })

    for (const scope of grant.accountingScopes) {
      expect(meter.inspect(scope.key)).toMatchObject({
        breakerOpen: true,
        reservedCalls: 0,
        reservedTokens: 0,
        debt: { calls: 1, inputTokens: 3, outputTokens: 8 },
      })
    }
    meter.close()
  })

  it('keeps a startup-shaped recovery probe single-flight until it resolves', async () => {
    vi.useFakeTimers()
    let resolveProbe: (() => void) | undefined
    const pendingProbe = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    const sink = { record: vi.fn(), probeHealth: vi.fn(() => pendingProbe) }
    const scope: LlmAccountingScope = {
      key: 'session:startup:player_0',
      limits: { tokenBudget: 100, callBudget: 10, requestsPerMinute: 10 },
      readCommittedUsage: emptyUsage,
    }
    const meter = new LlmMeter({ recoveryIntervalMs: 10 })
    meter.markUnavailable([scope], sink)

    vi.advanceTimersByTime(10)
    await Promise.resolve()
    expect(sink.probeHealth).toHaveBeenCalledOnce()
    expect(meter.inspect(scope.key).breakerOpen).toBe(true)
    vi.advanceTimersByTime(100)
    await Promise.resolve()
    expect(sink.probeHealth).toHaveBeenCalledOnce()

    resolveProbe?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(meter.inspect(scope.key).breakerOpen).toBe(false)
    meter.close()
  })
})
