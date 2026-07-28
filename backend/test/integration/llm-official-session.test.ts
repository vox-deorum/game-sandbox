/**
 * Stage 9.7 official-session boundary coverage using the production grant issuer, internal
 * listener, meter, telemetry store, and local OpenAI-compatible upstream. It stays Docker-free at
 * the component boundary, so it can test grant revocation and exact proxy outcomes without adding
 * a test-only container protocol.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LlmHandler } from '../../src/llm/handler.js'
import { KeyRegistry } from '../../src/llm/key-registry.js'
import { buildLlmListener } from '../../src/llm/listener.js'
import { LlmMeter } from '../../src/llm/meter.js'
import { TiktokenCounter } from '../../src/llm/tokenizer.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'
import { createOfficialGrantIssuer } from '../../src/session/official-grants.js'
import { ExecutionTelemetryStore } from '../../src/storage/llm/execution-telemetry.js'
import {
  createLlmUpstreamStub,
  type LlmUpstreamStub,
  RETRY_SUCCESS_ATTEMPTS,
} from './support/llm-upstream.js'

const SCOPE_ID = 'official-session'
const PLAYER = 'player_2'

describe('official LLM session grant lifecycle', () => {
  let root: string
  let upstream: LlmUpstreamStub
  let telemetry: ExecutionTelemetryStore
  let meter: LlmMeter
  let tokenizer: TiktokenCounter
  let listener: Awaited<ReturnType<typeof buildLlmListener>>
  let listenerAddress: string

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gs-official-llm-session-'))
    upstream = createLlmUpstreamStub()
    const upstreamAddress = await upstream.listen()
    telemetry = new ExecutionTelemetryStore(join(root, 'telemetry'))
    meter = new LlmMeter()
    tokenizer = new TiktokenCounter('cl100k_base')
    const registry = new KeyRegistry()
    listener = await buildLlmListener({
      registry,
      handler: new LlmHandler({
        meter,
        tokenizer,
        upstream: new UpstreamCaller({
          baseURL: `${upstreamAddress}/v1`,
          apiKey: 'upstream-secret',
          timeoutMs: 2_000,
          maxRetries: 2,
        }),
        options: { defaultMaxOutputTokens: 4, maxOutputTokens: 8 },
      }),
    })
    listenerAddress = await listener.listen({ port: 0, host: '127.0.0.1' })
    // Keep the production issuer available to this suite's isolated public setup helper.
    issuer = createOfficialGrantIssuer(registry, telemetry)
  })

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.revoke()))
    await listener.close()
    tokenizer.close()
    telemetry.close()
    await upstream.close()
    rmSync(root, { recursive: true, force: true })
  })

  let issuer: ReturnType<typeof createOfficialGrantIssuer>

  async function issue(sessionId = SCOPE_ID, scopeId = SCOPE_ID): Promise<string> {
    const lease = await issuer.issue({
      sessionId,
      scopeId,
      agentPlayers: [PLAYER],
      models: { small: { upstream: 'provider-small', costWeight: 2 } },
      limits: { tokenBudget: 1_000, requestsPerMinute: 20 },
    })
    leases.push(lease)
    const key = lease.keys[PLAYER]
    if (key === undefined) throw new Error('expected a player key')
    return key
  }

  const leases: Array<{ revoke(): Promise<void> }> = []

  async function request(key: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${listenerAddress}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async function markTick(key: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${listenerAddress}/internal/tick`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('writes setup and turn rows for the issuing player, then rejects its saved key after exit', async () => {
    const key = await issue()
    expect((await markTick(key, { phase: 'setup' })).status).toBe(200)
    expect(
      (
        await request(key, {
          model: 'small',
          messages: [{ role: 'user', content: '[stub:success] setup request' }],
        })
      ).status,
    ).toBe(200)
    expect((await markTick(key, { tick: 17 })).status).toBe(200)
    expect(
      (
        await request(key, {
          model: 'small',
          messages: [{ role: 'user', content: '[stub:success] turn request' }],
        })
      ).status,
    ).toBe(200)

    expect(telemetry.listCalls(SCOPE_ID)).toEqual([
      expect.objectContaining({ sessionId: SCOPE_ID, player: PLAYER, tick: null, model: 'small' }),
      expect.objectContaining({ sessionId: SCOPE_ID, player: PLAYER, tick: 17, model: 'small' }),
    ])

    const lease = leases[0]
    if (lease === undefined) throw new Error('expected an issued lease')
    await lease.revoke()
    expect((await request(key, { model: 'small', messages: [] })).status).toBe(401)
    expect((await markTick(key, { tick: 18 })).status).toBe(401)
  })

  it.each([
    ['non-retryable upstream response', 'non-retryable', 400, 1],
    ['exhausted retryable upstream response', 'retry-exhausted', 503, RETRY_SUCCESS_ATTEMPTS],
  ])('does not charge or write a row after a %s', async (_name, scenario, expectedStatus, attempts) => {
    const scopeId = `${SCOPE_ID}-${scenario}`
    const key = await issue(scopeId, scopeId)

    const response = await request(key, {
      model: 'small',
      messages: [{ role: 'user', content: `[stub:${scenario}] terminal request` }],
    })

    expect(response.status).toBe(expectedStatus)
    expect(upstream.requests).toHaveLength(attempts)
    expect(telemetry.listCalls(scopeId)).toEqual([])
    expect(meter.inspect(`official:${scopeId}:${PLAYER}`)).toMatchObject({
      rateEvents: [],
      reservedWeightedTokens: 0,
    })
  })
})
