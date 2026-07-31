import type OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmError } from '../../src/llm/errors.js'
import { LlmHandler } from '../../src/llm/handler.js'
import { createOfficialTickMarker, KeyRegistry } from '../../src/llm/key-registry.js'
import { buildLlmListener } from '../../src/llm/listener.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { LlmTokenCounter } from '../../src/llm/tokenizer.js'
import {
  type LlmAccountingScope,
  type LlmChatCompletion,
  type LlmChatRequest,
  type LlmGrant,
  type LlmSuccessfulRecord,
  type ModelAlias,
  weightedCommittedTokens,
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
  overrides: {
    model?: { tier: ModelAlias; upstream: string; costWeight: number }
    rpm?: number
    sink?: LlmGrant['recordSink']
    tokenizer?: LlmTokenCounter
  } = {},
) {
  const model = overrides.model ?? { tier: 'small', upstream: 'provider-secret', costWeight: 1 }
  const records: LlmSuccessfulRecord[] = []
  const scope: LlmAccountingScope = {
    key: 'session:s1:player_0',
    limits: { tokenBudget: 100, requestsPerMinute: overrides.rpm ?? 10 },
    weights: { [model.tier]: model.costWeight },
    readCommittedUsage: () => ({}),
  }
  const sink =
    overrides.sink ??
    ((record: LlmSuccessfulRecord) => {
      records.push(record)
    })
  const grant = {
    kind: 'official',
    models: { [model.tier]: { upstream: model.upstream, costWeight: model.costWeight } },
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
  const log = (message: string): void => {
    logs.push(message)
  }
  const meter = new LlmMeter({ log })
  const handler = new LlmHandler({
    meter,
    tokenizer,
    upstream,
    options: { defaultMaxOutputTokens: 8, maxOutputTokens: 20 },
    log,
  })
  return { grant, handler, logs, meter, records, tokenizer, upstream }
}

describe('LLM registry, handler, and listener', () => {
  it.each([
    ['small', 'provider-small', 1],
    ['medium', 'provider-medium', 2],
    ['large', 'provider-large', 4],
  ] as const)('maps the public %s tier to its configured upstream model and retains the tier in telemetry', async (tier, upstreamModel, costWeight) => {
    const { grant, handler, records, upstream } = fixture({
      model: { tier, upstream: upstreamModel, costWeight },
    })

    const response = await handler.handle(grant, { model: tier, messages: [] })

    expect(upstream.call).toHaveBeenCalledWith(
      expect.objectContaining({ model: upstreamModel, max_completion_tokens: 8 }),
    )
    expect(response.model).toBe(tier)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      model: tier,
      costWeight,
      request: { model: tier },
      completion: { model: tier },
    })
  })

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
      costWeight: 1,
      budgetCostUnits: 6,
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
      costWeight: 1,
      budgetCostUnits: 8,
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
    const key = registry.issueOfficial('s1', grant, tick, () => grant.recordSink)
    const otherTick = createOfficialTickMarker()
    const otherKey = registry.issueOfficial('s2', grant, otherTick, () => grant.recordSink)
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

  it('closes official admission immediately and drains requests through accounting finalization', async () => {
    let startFinalizer = (): void => {}
    const finalizerStarted = new Promise<void>((resolve) => {
      startFinalizer = resolve
    })
    let finishFinalizer = (): void => {}
    const finalizerGate = new Promise<void>((resolve) => {
      finishFinalizer = resolve
    })
    let finalized = false
    const { grant, handler, meter } = fixture({
      sink: async () => {
        startFinalizer()
        await finalizerGate
        finalized = true
      },
    })
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(2))
    const tick = createOfficialTickMarker()
    const key = registry.issueOfficial('s1', grant, tick, () => grant.recordSink)
    const app = await buildLlmListener({ registry, handler })

    const activeRequest = app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    await finalizerStarted

    const revocation = registry.revokeSession('s1')
    expect(registry.revokeSession('s1')).toBe(revocation)
    let revoked = false
    void revocation.then(() => {
      revoked = true
    })
    await Promise.resolve()
    expect(revoked).toBe(false)
    expect(meter.inspect(grant.accountingScope.key).reservedWeightedTokens).toBe(11)

    const deniedCompletion = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(deniedCompletion.statusCode).toBe(401)
    const deniedTick = await app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: { authorization: `Bearer ${key}` },
      payload: { tick: 9 },
    })
    expect(deniedTick.statusCode).toBe(401)
    expect(tick.current).toBeNull()
    expect(revoked).toBe(false)

    finishFinalizer()
    await expect(activeRequest).resolves.toMatchObject({ statusCode: 200 })
    await revocation
    expect(finalized).toBe(true)
    expect(revoked).toBe(true)
    expect(meter.inspect(grant.accountingScope.key).reservedWeightedTokens).toBe(0)
    await app.close()
  })

  it('aborts pre-success upstream work and releases its reservation during revocation', async () => {
    const { grant, handler, meter, upstream } = fixture()
    let markStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    upstream.call.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_, reject) => {
          markStarted()
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(3))
    const key = registry.issueOfficial(
      's1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const app = await buildLlmListener({ registry, handler })

    const activeRequest = app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    await started
    await registry.revokeSession('s1')

    const response = await activeRequest
    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'request_cancelled' } })
    expect(meter.inspect(grant.accountingScope.key).reservedWeightedTokens).toBe(0)
    await app.close()
  })

  it('accrues in-flight ms across a successful and a failed call and serves it to the harness', async () => {
    let now = 1_000
    const { grant, handler, upstream } = fixture()
    upstream.call
      .mockImplementationOnce(async () => {
        now += 40
        return {
          completion: completion({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }),
          latencyMs: 40,
        }
      })
      .mockImplementationOnce(async () => {
        now += 25
        throw new LlmError(400, 'bad_upstream', 'bad')
      })
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(9), { now: () => now })
    const key = registry.issueOfficial(
      's1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const app = await buildLlmListener({ registry, handler })

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(ok.statusCode).toBe(200)
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(40)
    expect(registry.blockingInFlightMs('s1')).toBe(40)

    const failed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(failed.statusCode).toBe(400)
    // A failed call still counts: timing authority stays with the proxy for the whole logical request.
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(65)
    expect(registry.blockingInFlightMs('s1')).toBe(65)

    const inflight = await app.inject({
      method: 'POST',
      url: '/internal/inflight',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(inflight.json()).toEqual({ inflight_ms: 65 })
    const tick = await app.inject({
      method: 'POST',
      url: '/internal/tick',
      headers: { authorization: `Bearer ${key}` },
      payload: { phase: 'setup' },
    })
    expect(tick.json()).toEqual({ ok: true })
    await app.close()
  })

  it('classifies only the exact background header as non-blocking while preserving total timing', async () => {
    let now = 1_000
    const { grant, handler, upstream } = fixture()
    upstream.call.mockImplementation(async () => {
      now += 10
      return {
        completion: completion({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }),
        latencyMs: 10,
      }
    })
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(8), { now: () => now })
    const key = registry.issueOfficial(
      's1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const app = await buildLlmListener({ registry, handler })

    for (const headers of [
      {},
      { 'x-game-sandbox-background': '1' },
      { 'x-game-sandbox-background': 'true' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}`, ...headers },
        payload: { model: 'small', messages: [] },
      })
      expect(response.statusCode).toBe(200)
    }

    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(30)
    expect(registry.blockingInFlightMs('s1')).toBe(20)
    const inflight = await app.inject({
      method: 'POST',
      url: '/internal/inflight',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(inflight.json()).toEqual({ inflight_ms: 30 })
    await app.close()
  })

  it('binds successful telemetry to the admission marker, including setup null', async () => {
    const { grant, handler, upstream } = fixture()
    const tick = createOfficialTickMarker()
    const admissions: Array<{ admitted: number | null; committed: number | null }> = []
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(7))
    const key = registry.issueOfficial('s1', grant, tick, (admitted) => () => {
      admissions.push({ admitted, committed: tick.current })
    })
    const app = await buildLlmListener({ registry, handler })
    upstream.call
      .mockImplementationOnce(async () => {
        tick.current = 4
        return {
          completion: completion({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }),
          latencyMs: 1,
        }
      })
      .mockImplementationOnce(async () => {
        tick.current = 13
        return {
          completion: completion({ prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 }),
          latencyMs: 1,
        }
      })

    const setupCall = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(setupCall.statusCode).toBe(200)

    tick.current = 12
    const turnCall = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(turnCall.statusCode).toBe(200)
    expect(admissions).toEqual([
      { admitted: null, committed: 4 },
      { admitted: 12, committed: 13 },
    ])
    await app.close()
  })

  it('counts a capped active-request partial toward the session and clears accumulators on revocation', async () => {
    let now = 1_000
    const { grant, handler, upstream } = fixture()
    let markStarted = (): void => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    upstream.call.mockImplementationOnce(
      (_request, signal) =>
        new Promise((_, reject) => {
          markStarted()
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(4), {
      now: () => now,
      maxRequestMs: 15,
    })
    const key = registry.issueOfficial(
      's1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const app = await buildLlmListener({ registry, handler })

    const active = app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    await started
    now = 1_050
    // The active request has run 50 ms, but a single call may contribute at most maxRequestMs (15).
    expect(registry.blockingInFlightMs('s1')).toBe(15)
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(15)
    const inflight = await app.inject({
      method: 'POST',
      url: '/internal/inflight',
      headers: { authorization: `Bearer ${key}` },
    })
    expect(inflight.json()).toEqual({ inflight_ms: 15 })

    await registry.revokeSession('s1')
    await active
    // Revocation clears the per-session blocking view and the per-scope accumulator.
    expect(registry.blockingInFlightMs('s1')).toBe(0)
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(0)
    await app.close()
  })

  it('indexes active requests by scope and removes them as their sessions drain', async () => {
    let now = 1_000
    let issued = 10
    const { grant } = fixture()
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

    now = 1_050
    // Two requests in one scope each contribute their capped partial, while the other scope is isolated.
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(30)
    expect(registry.inFlightMsForScope(otherGrant.accountingScope.key)).toBe(15)

    first.release()
    // Released work remains capped when it moves to the cumulative counter. The other active
    // request contributes its own capped partial.
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(30)
    const revocation = registry.revokeSession('s1')
    second.release()
    await revocation

    // Draining the session clears its cumulative state and its last active-scope entry.
    expect(registry.inFlightMsForScope(grant.accountingScope.key)).toBe(0)
    expect(registry.inFlightMsForScope(otherGrant.accountingScope.key)).toBe(15)

    other.release()
    await registry.revokeSession('s2')
    expect(registry.inFlightMsForScope(otherGrant.accountingScope.key)).toBe(0)
  })

  it.each([
    undefined,
    'Basic abc',
    'Bearer',
    'Bearer one two',
  ])('returns the pinned authentication envelope for malformed authorization %s', async (authorization) => {
    const { grant, handler, upstream } = fixture()
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(1))
    registry.issueOfficial('s1', grant, createOfficialTickMarker(), () => grant.recordSink)
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

  it('rejects a disabled model tier with the standard model_not_allowed error', async () => {
    const { grant, handler, upstream } = fixture()

    await expect(handler.handle(grant, { model: 'large', messages: [] })).rejects.toMatchObject({
      status: 400,
      code: 'model_not_allowed',
      message: 'The requested model tier is not allowed.',
    })
    expect(upstream.call).not.toHaveBeenCalled()
  })
})

describe('generic admission and unavailable scopes', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['token', { tokenBudget: 10, requestsPerMinute: 10 }, 3, 3],
    ['rate', { tokenBudget: 100, requestsPerMinute: 1 }, 2, 3],
  ])('makes concurrent %s reservations observe one atomic budget', async (_kind, limits, input, output) => {
    const meter = new LlmMeter()
    const accountingScope: LlmAccountingScope = {
      key: `concurrent:${_kind}`,
      limits,
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const outcomes = await Promise.allSettled([
      meter.reserve(accountingScope, 'small', input, output),
      meter.reserve(accountingScope, 'small', input, output),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(rejected).toMatchObject({
      reason: { code: _kind === 'rate' ? 'rate_limit_exceeded' : 'budget_exceeded' },
    })
    expect(meter.inspect(accountingScope.key)).toMatchObject({
      reservedWeightedTokens: input + output,
    })
    expect(meter.inspect(accountingScope.key).pendingRateEvents.size).toBe(1)
    const accepted = outcomes.find((outcome) => outcome.status === 'fulfilled')
    if (accepted?.status === 'fulfilled') meter.release(accepted.value)
  })

  it('weights mixed committed usage and pending large-model capacity at the exact boundary', async () => {
    const meter = new LlmMeter()
    const scope: LlmAccountingScope = {
      key: 'weighted:mixed',
      limits: { tokenBudget: 20, requestsPerMinute: 10 },
      weights: { large: 4, medium: 2, small: 1 },
      readCommittedUsage: () => ({
        small: { calls: 0, inputTokens: 1, reasoningTokens: 0, outputTokens: 1 },
        medium: { calls: 0, inputTokens: 1, reasoningTokens: 0, outputTokens: 2 },
      }),
    }

    const admitted = await meter.reserve(scope, 'large', 1, 2)
    expect(meter.inspect(scope.key).reservedWeightedTokens).toBe(12)
    await expect(meter.reserve(scope, 'small', 0, 1)).rejects.toMatchObject({
      code: 'budget_exceeded',
    })
    meter.release(admitted)
  })

  it('carries a fractional weight through reservation arithmetic without rounding it away', async () => {
    const meter = new LlmMeter()
    const scope: LlmAccountingScope = {
      key: 'weighted:fractional',
      limits: { tokenBudget: 10, requestsPerMinute: 10 },
      weights: { small: 0.5 },
      readCommittedUsage: () => ({
        small: { calls: 1, inputTokens: 4, reasoningTokens: 0, outputTokens: 4 },
      }),
    }

    // Committed usage is already 4 weighted units (8 tokens at weight 0.5). Reserving 5+6 tokens
    // adds 5.5 weighted units, for a running total of 9.5, still inside the budget of 10.
    const admitted = await meter.reserve(scope, 'small', 5, 6)
    expect(meter.inspect(scope.key).reservedWeightedTokens).toBe(5.5)

    // One more weighted unit (1+1 tokens at weight 0.5) pushes the total to 10.5, over budget.
    await expect(meter.reserve(scope, 'small', 1, 1)).rejects.toMatchObject({
      code: 'budget_exceeded',
    })
    meter.release(admitted)
  })

  it.each([
    'retired',
    'constructor',
    '__proto__',
  ])('uses the highest configured weight for unknown committed alias %s', (alias) => {
    const byModel = {
      [alias]: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 3 },
    }
    expect(weightedCommittedTokens(byModel, { medium: 2, small: 1 })).toBe(10)
  })

  it('keeps official player and development-shaped accounting keys independent', async () => {
    const meter = new LlmMeter()
    const makeScope = (key: string): LlmAccountingScope => ({
      key,
      limits: { tokenBudget: 100, requestsPerMinute: 1 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    })
    const sessionA = makeScope('session:s1:player_0')
    const sessionB = makeScope('session:s1:player_1')
    const development = makeScope('development:participant-1:season-1')

    // Convert each pending rate reservation into the event a successful call would retain.
    for (const scope of [sessionA, sessionB, development]) {
      const reservation = await meter.reserve(scope, 'small', 1, 1)
      meter.recordRateEvent(reservation)
      meter.release(reservation)
    }
    for (const scope of [sessionA, sessionB, development]) {
      expect(meter.inspect(scope.key).rateEvents).toHaveLength(1)
    }
    // Each window is independent and full at rpm=1, so the next reservation on any scope is limited.
    await expect(meter.reserve(development, 'small', 1, 1)).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    expect(meter.inspect(sessionB.key).rateEvents).toHaveLength(1)
  })

  it('retains successful request starts in time order when concurrent requests finish out of order', async () => {
    let now = 1_000
    const meter = new LlmMeter({ now: () => now })
    const scope: LlmAccountingScope = {
      key: 'concurrent:rate-order',
      limits: { tokenBudget: 100, requestsPerMinute: 2 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const first = await meter.reserve(scope, 'small', 1, 1)
    now = 1_010
    const second = await meter.reserve(scope, 'small', 1, 1)

    meter.recordRateEvent(second)
    meter.release(second)
    now = 1_020
    meter.recordRateEvent(first)
    meter.release(first)

    expect(meter.inspect(scope.key)).toMatchObject({
      rateEvents: [1_000, 1_010],
    })
    expect(meter.inspect(scope.key).pendingRateEvents.size).toBe(0)
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
    const first = await meter.reserve(scope, 'small', 1, 1)
    now = 1_010
    const second = await meter.reserve(scope, 'small', 1, 1)

    meter.recordRateEvent(second)
    meter.release(second)
    meter.release(first)

    expect(meter.inspect(scope.key).rateEvents).toEqual([1_010])
    expect(meter.inspect(scope.key).pendingRateEvents.size).toBe(0)
    const admitted = await meter.reserve(scope, 'small', 1, 1)
    // The freed capacity is occupied again: one recorded event plus the new pending reservation.
    expect(meter.inspect(scope.key).rateEvents).toEqual([1_010])
    expect(meter.inspect(scope.key).pendingRateEvents.size).toBe(1)
    meter.release(admitted)
  })

  it('expires pending rate capacity when its request start leaves the sliding window', async () => {
    let now = 1_000
    const meter = new LlmMeter({ now: () => now })
    const scope: LlmAccountingScope = {
      key: 'concurrent:rate-expiry',
      limits: { tokenBudget: 100, requestsPerMinute: 1 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const expired = await meter.reserve(scope, 'small', 1, 1)
    now = 61_001
    const current = await meter.reserve(scope, 'small', 1, 1)

    meter.recordRateEvent(expired)
    meter.release(expired)
    expect(meter.inspect(scope.key).rateEvents).toEqual([])
    expect(meter.inspect(scope.key).pendingRateEvents.size).toBe(1)
    meter.release(current)
  })

  it('retains no event for a success whose start left the window even without an intervening prune', async () => {
    let now = 1_000
    const meter = new LlmMeter({ now: () => now })
    const scope: LlmAccountingScope = {
      key: 'concurrent:rate-late-success',
      limits: { tokenBudget: 100, requestsPerMinute: 1 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const slow = await meter.reserve(scope, 'small', 1, 1)
    now = 61_001

    meter.recordRateEvent(slow)
    meter.release(slow)
    expect(meter.inspect(scope.key).rateEvents).toEqual([])
    expect(meter.inspect(scope.key).pendingRateEvents.size).toBe(0)
  })

  it('ignores a duplicate record on a live reservation and throws on a finalized one', async () => {
    let now = 1_000
    const meter = new LlmMeter({ now: () => now })
    const scope: LlmAccountingScope = {
      key: 'concurrent:rate-finalized',
      limits: { tokenBudget: 100, requestsPerMinute: 5 },
      weights: { small: 1 },
      readCommittedUsage: () => ({}),
    }
    const recorded = await meter.reserve(scope, 'small', 1, 1)
    meter.recordRateEvent(recorded)
    meter.recordRateEvent(recorded)
    expect(meter.inspect(scope.key).rateEvents).toEqual([1_000])
    meter.release(recorded)

    now = 1_010
    const released = await meter.reserve(scope, 'small', 1, 1)
    meter.release(released)
    expect(() => meter.recordRateEvent(released)).toThrow(
      'LLM rate reservation was already finalized',
    )
    expect(meter.inspect(scope.key).rateEvents).toEqual([1_000])
    expect(meter.inspect(scope.key).pendingRateEvents.size).toBe(0)
  })

  it('records no rate event after a terminal upstream failure so a later request still reaches upstream', async () => {
    const { grant, handler, meter, upstream } = fixture({ rpm: 1 })
    upstream.call.mockRejectedValue(new LlmError(400, 'bad_upstream', 'bad'))
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'bad_upstream',
    })
    expect(meter.inspect(grant.accountingScope.key)).toMatchObject({
      rateEvents: [],
    })
    expect(meter.inspect(grant.accountingScope.key).pendingRateEvents.size).toBe(0)
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'bad_upstream',
    })
    expect(upstream.call).toHaveBeenCalledTimes(2)
  })

  it('records one rate event per success and limits the next call once the window is full at rpm=1', async () => {
    const { grant, handler, meter, upstream } = fixture({ rpm: 1 })
    await handler.handle(grant, { model: 'small', messages: [] })
    expect(meter.inspect(grant.accountingScope.key).rateEvents).toHaveLength(1)
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'rate_limit_exceeded',
    })
    expect(upstream.call).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed record scope unavailable for the process lifetime', async () => {
    const sink = vi.fn(() => {
      throw new Error('disk full')
    })
    const { grant, handler, meter, upstream } = fixture({ sink })
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'meter_unavailable',
    })
    const key = grant.accountingScope.key
    expect(meter.inspect(key)).toMatchObject({
      unavailable: true,
      reservedWeightedTokens: 0,
    })
    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      code: 'meter_unavailable',
    })
    expect(upstream.call).toHaveBeenCalledTimes(1)
  })

  it('releases without blocking the scope when estimation fails after upstream success', async () => {
    const sink = vi.fn()
    const tokenizer: LlmTokenCounter = {
      countRequest: () => 3,
      countCompletion: () => {
        throw new Error('estimator failed')
      },
    }
    const { grant, handler, logs, meter, upstream } = fixture({ sink, tokenizer })
    upstream.call.mockResolvedValueOnce({ completion: completion(null), latencyMs: 1 })

    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toThrow(
      'estimator failed',
    )

    const key = grant.accountingScope.key
    // The provider was paid for work no row will ever describe, so the operator gets a diagnostic.
    expect(logs).toEqual([`LLM handler ${key}: small spend was not accounted: estimator failed`])
    expect(sink).not.toHaveBeenCalled()
    expect(meter.inspect(key)).toMatchObject({
      unavailable: false,
      reservedWeightedTokens: 0,
    })
    await expect(handler.handle(grant, { model: 'small', messages: [] })).resolves.toMatchObject({
      model: 'small',
    })
    expect(upstream.call).toHaveBeenCalledTimes(2)
    expect(sink).toHaveBeenCalledOnce()
  })

  it('releases without blocking the scope when completion redaction fails', async () => {
    const { grant, handler, meter, records, upstream } = fixture()
    const malformed = {
      ...completion({
        prompt_tokens: 2,
        completion_tokens: 4,
        total_tokens: 6,
      }),
      moderation: {
        input: { model: 'provider-secret', results: null },
        output: { model: 'provider-secret', results: [] },
      },
    } as unknown as LlmChatCompletion
    upstream.call.mockResolvedValueOnce({ completion: malformed, latencyMs: 1 })

    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toThrow()
    expect(meter.inspect(grant.accountingScope.key)).toMatchObject({
      unavailable: false,
      reservedWeightedTokens: 0,
    })

    await expect(handler.handle(grant, { model: 'small', messages: [] })).resolves.toMatchObject({
      model: 'small',
    })
    expect(upstream.call).toHaveBeenCalledTimes(2)
    expect(records).toHaveLength(1)
  })

  it('answers an unresolvable usage failure with a compatible internal error', async () => {
    const tokenizer: LlmTokenCounter = {
      countRequest: () => 3,
      countCompletion: () => {
        throw new Error('estimator failed')
      },
    }
    const { grant, handler, logs, meter, upstream } = fixture({ sink: vi.fn(), tokenizer })
    upstream.call.mockResolvedValueOnce({ completion: completion(null), latencyMs: 1 })
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(9))
    const key = registry.issueOfficial(
      's1',
      grant,
      createOfficialTickMarker(),
      () => grant.recordSink,
    )
    const app = await buildLlmListener({ registry, handler })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })

    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({
      error: {
        message: 'The LLM proxy encountered an internal error.',
        type: 'server_error',
        code: 'internal_error',
      },
    })
    expect(meter.inspect(grant.accountingScope.key).unavailable).toBe(false)
    expect(logs).toHaveLength(1)
    await app.close()
  })
})
