import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APIError } from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmHandler } from '../../src/llm/handler.js'
import { createOfficialTickMarker, KeyRegistry } from '../../src/llm/key-registry.js'
import { buildLlmListener } from '../../src/llm/listener.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { LlmChatCompletion, LlmGrant } from '../../src/llm/types.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'
import { ExecutionTelemetryStore } from '../../src/storage/llm/execution-telemetry.js'
import { createOfficialRecordSink } from '../../src/storage/llm/official-record-sink.js'

const SESSION_ID = 'session-1'
const PLAYER = 'player_0'

function statusError(status: number): APIError {
  return APIError.generate(
    status,
    { error: { message: `upstream ${status}`, type: 'provider_error', code: `e${status}` } },
    undefined,
    new Headers(),
  )
}

function completion(): LlmChatCompletion {
  return {
    id: 'completion-1',
    object: 'chat.completion',
    created: 1,
    model: 'provider-small',
    choices: [],
    usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
  }
}

describe('LLM retry, accounting, and telemetry pipeline', () => {
  const roots: string[] = []
  const stores: ExecutionTelemetryStore[] = []

  afterEach(() => {
    for (const store of stores.splice(0)) store.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function pipeline(client: { create: ReturnType<typeof vi.fn> }, initialTick: number | null = 7) {
    const root = mkdtempSync(join(tmpdir(), 'gs-llm-pipeline-'))
    roots.push(root)
    const store = new ExecutionTelemetryStore(root)
    stores.push(store)
    const meter = new LlmMeter()
    const tick = createOfficialTickMarker()
    tick.current = initialTick
    const grant = {
      kind: 'official',
      models: { small: { upstream: 'provider-small', costWeight: 1 } },
      accountingScope: {
        key: `session:${SESSION_ID}:${PLAYER}`,
        limits: { tokenBudget: 100, requestsPerMinute: 10 },
        weights: { small: 1 },
        readCommittedUsage: () => store.readSessionUsageByModel(SESSION_ID, SESSION_ID, PLAYER),
      },
      recordSink: createOfficialRecordSink(store, {
        scopeId: SESSION_ID,
        sessionId: SESSION_ID,
        player: PLAYER,
        tick: initialTick,
      }),
    } satisfies LlmGrant
    const upstream = new UpstreamCaller({
      baseURL: 'http://stub.invalid',
      timeoutMs: 50,
      maxRetries: 1,
      client,
    })
    const handler = new LlmHandler({
      meter,
      tokenizer: { countRequest: () => 2, countCompletion: () => 4 },
      upstream,
      options: { defaultMaxOutputTokens: 8, maxOutputTokens: 20 },
    })
    return { client, grant, handler, meter, store, tick }
  }

  it('records one SDK-returned success and one telemetry row', async () => {
    const client = {
      create: vi.fn().mockResolvedValue(completion()),
    }
    const { grant, handler, meter, store } = pipeline(client)

    const response = await handler.handle(grant, { model: 'small', messages: [] })

    expect(response).toMatchObject({
      id: 'completion-1',
      model: 'small',
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
    })

    expect(client.create).toHaveBeenCalledOnce()
    expect(store.readSessionUsageByModel(SESSION_ID, SESSION_ID, PLAYER)).toEqual({
      small: {
        calls: 1,
        inputTokens: 2,
        reasoningTokens: 0,
        outputTokens: 4,
      },
    })
    expect(store.listCalls(SESSION_ID)).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        player: PLAYER,
        tick: 7,
        completion: response,
      }),
    ])
    expect(meter.inspect(grant.accountingScope.key).rateEvents).toHaveLength(1)
  })

  it('persists the admission tick after setup and turn markers change before commit', async () => {
    const client = { create: vi.fn() }
    const { grant, handler, store, tick } = pipeline(client, null)
    const registry = new KeyRegistry(() => new Uint8Array(32).fill(6))
    const recordSinkForTick = (admissionTick: number | null) =>
      createOfficialRecordSink(store, {
        scopeId: SESSION_ID,
        sessionId: SESSION_ID,
        player: PLAYER,
        tick: admissionTick,
      })
    const key = registry.issueOfficial(SESSION_ID, grant, tick, recordSinkForTick)
    const app = await buildLlmListener({ registry, handler })
    client.create
      .mockImplementationOnce(async () => {
        tick.current = 9
        return completion()
      })
      .mockImplementationOnce(async () => {
        tick.current = 18
        return completion()
      })

    const setup = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(setup.statusCode).toBe(200)
    tick.current = 12
    const turn = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { model: 'small', messages: [] },
    })
    expect(turn.statusCode).toBe(200)

    expect(store.listCalls(SESSION_ID)).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, player: PLAYER, tick: null }),
      expect.objectContaining({ sessionId: SESSION_ID, player: PLAYER, tick: 12 }),
    ])
    await app.close()
  })

  it.each([
    ['non-retryable response', 400],
    ['retryable response returned by the SDK', 500],
  ])('leaves no durable charge or row after a %s', async (_name, status) => {
    const client = { create: vi.fn().mockRejectedValue(statusError(status)) }
    const { grant, handler, meter, store } = pipeline(client)

    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      status,
    })

    expect(client.create).toHaveBeenCalledOnce()
    expect(store.readSessionUsageByModel(SESSION_ID, SESSION_ID, PLAYER)).toEqual({})
    expect(store.listCalls(SESSION_ID)).toEqual([])
    expect(meter.inspect(grant.accountingScope.key)).toMatchObject({
      rateEvents: [],
      reservedWeightedTokens: 0,
    })
  })
})
