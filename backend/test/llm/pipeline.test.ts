import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APIError } from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LlmHandler } from '../../src/llm/handler.js'
import { LlmMeter } from '../../src/llm/meter.js'
import type { LlmChatCompletion, LlmGrant } from '../../src/llm/types.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'
import { ExecutionTelemetryStore } from '../../src/storage/llm/execution-telemetry.js'
import { createOfficialRecordSink } from '../../src/storage/llm/official-record-sink.js'

const SESSION_ID = 'session-1'
const SLOT = 'player_0'

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

  function pipeline(client: { create: ReturnType<typeof vi.fn> }, maxRetries = 1) {
    const root = mkdtempSync(join(tmpdir(), 'gs-llm-pipeline-'))
    roots.push(root)
    const store = new ExecutionTelemetryStore(root)
    stores.push(store)
    const meter = new LlmMeter({ recoveryIntervalMs: 10 })
    const grant: LlmGrant = {
      kind: 'official',
      models: { small: 'provider-small' },
      accountingScope: {
        key: `session:${SESSION_ID}:${SLOT}`,
        limits: { tokenBudget: 100, callBudget: 10, requestsPerMinute: 10 },
        readCommittedUsage: () => store.readSessionUsage(SESSION_ID, SESSION_ID, SLOT),
      },
      recordSink: createOfficialRecordSink(store, {
        scopeId: SESSION_ID,
        sessionId: SESSION_ID,
        slot: SLOT,
        tick: { current: 7 },
      }),
    }
    const upstream = new UpstreamCaller({
      baseURL: 'http://stub.invalid',
      timeoutMs: 50,
      maxRetries,
      retryIntervalMs: 1,
      client,
      sleep: async () => {},
    })
    const handler = new LlmHandler({
      meter,
      tokenizer: { countRequest: () => 2, countCompletion: () => 4 },
      upstream,
      options: { defaultMaxOutputTokens: 8, maxOutputTokens: 20 },
    })
    return { client, grant, handler, meter, store }
  }

  it('retries to one success, one durable charge, and one telemetry row', async () => {
    const client = {
      create: vi.fn().mockRejectedValueOnce(statusError(429)).mockResolvedValueOnce(completion()),
    }
    const { grant, handler, meter, store } = pipeline(client)

    await expect(handler.handle(grant, { model: 'small', messages: [] })).resolves.toMatchObject({
      model: 'small',
    })

    expect(client.create).toHaveBeenCalledTimes(2)
    expect(store.readSessionUsage(SESSION_ID, SESSION_ID, SLOT)).toEqual({
      calls: 1,
      inputTokens: 2,
      reasoningTokens: 0,
      outputTokens: 4,
    })
    expect(store.listCalls(SESSION_ID)).toHaveLength(1)
    expect(meter.inspect(grant.accountingScope.key).rateEvents).toHaveLength(1)
  })

  it.each([
    ['non-retryable response', 400, 3, 1],
    ['exhausted retryable response', 500, 1, 2],
  ])('leaves no durable charge or row after a %s', async (_name, status, maxRetries, attempts) => {
    const client = { create: vi.fn().mockRejectedValue(statusError(status)) }
    const { grant, handler, meter, store } = pipeline(client, maxRetries)

    await expect(handler.handle(grant, { model: 'small', messages: [] })).rejects.toMatchObject({
      status,
    })

    expect(client.create).toHaveBeenCalledTimes(attempts)
    expect(store.readSessionUsage(SESSION_ID, SESSION_ID, SLOT)).toEqual({
      calls: 0,
      inputTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
    })
    expect(store.listCalls(SESSION_ID)).toEqual([])
    expect(meter.inspect(grant.accountingScope.key)).toMatchObject({
      rateEvents: [expect.any(Number)],
      reservedCalls: 0,
      reservedTokens: 0,
    })
  })
})
