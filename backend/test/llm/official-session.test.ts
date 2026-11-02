import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LlmHandler } from '../../src/llm/handler.js'
import { KeyRegistry } from '../../src/llm/key-registry.js'
import { buildLlmListener } from '../../src/llm/listener.js'
import { LlmMeter } from '../../src/llm/meter.js'
import { TiktokenCounter } from '../../src/llm/tokenizer.js'
import { UpstreamCaller } from '../../src/llm/upstream.js'
import {
  createOfficialGrantIssuer,
  type IssueOfficialGrantsInput,
  type OfficialGrantLease,
} from '../../src/session/official-grants.js'
import { ExecutionTelemetryStore } from '../../src/storage/llm/execution-telemetry.js'
import { createLlmUpstreamStub, type LlmUpstreamStub } from '../support/llm-upstream.js'

const SCOPE_ID = 'official-session'
const PLAYER = 'player_2'

describe('official LLM session grant lifecycle', () => {
  let root: string
  let upstream: LlmUpstreamStub
  let telemetry: ExecutionTelemetryStore
  let tokenizer: TiktokenCounter
  let listener: Awaited<ReturnType<typeof buildLlmListener>>
  let listenerAddress: string
  let issuer: ReturnType<typeof createOfficialGrantIssuer>
  let beforeSuccess: (() => Promise<void>) | undefined
  let upstreamTime: number
  const leases: OfficialGrantLease[] = []

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'gs-official-llm-session-'))
    beforeSuccess = undefined
    upstreamTime = 0
    upstream = createLlmUpstreamStub()
    upstream.app.addHook('preSerialization', async (_request, reply, payload) => {
      upstreamTime += 25
      if (reply.statusCode === 200) await beforeSuccess?.()
      return payload
    })
    const upstreamAddress = await upstream.listen()
    telemetry = new ExecutionTelemetryStore(join(root, 'telemetry'))
    tokenizer = new TiktokenCounter('cl100k_base')
    const registry = new KeyRegistry()
    listener = await buildLlmListener({
      registry,
      handler: new LlmHandler({
        meter: new LlmMeter(),
        tokenizer,
        upstream: new UpstreamCaller({
          baseURL: `${upstreamAddress}/v1`,
          apiKey: 'upstream-secret',
          timeoutMs: 2_000,
          maxRetries: 2,
          now: () => upstreamTime,
        }),
        options: { defaultMaxOutputTokens: 4, maxOutputTokens: 8 },
      }),
    })
    listenerAddress = await listener.listen({ port: 0, host: '127.0.0.1' })
    issuer = createOfficialGrantIssuer(registry, telemetry)
  })

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.revoke()))
    await listener.close()
    tokenizer.close()
    telemetry.close()
    await upstream.close()
    rmSync(root, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function issue(input: Partial<IssueOfficialGrantsInput> = {}): Promise<OfficialGrantLease> {
    const lease = await issuer.issue({
      sessionId: SCOPE_ID,
      scopeId: SCOPE_ID,
      agentPlayers: [PLAYER],
      models: { small: { upstream: 'provider-small', costWeight: 2 } },
      limits: { tokenBudget: 1_000, requestsPerMinute: 20 },
      ...input,
    })
    leases.push(lease)
    return lease
  }

  async function request(
    key: string | undefined,
    body: Record<string, unknown>,
    path = '/v1/chat/completions',
  ): Promise<Response> {
    if (key === undefined) throw new Error('expected an issued player key')
    return fetch(`${listenerAddress}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('commits retried setup and turn calls at their admission ticks, then revokes access', async () => {
    vi.spyOn(tokenizer, 'countRequest').mockReturnValue(2)
    // Committed cost 6 plus the next reservation 12 exactly fills the token allowance.
    const lease = await issue({ limits: { tokenBudget: 18, requestsPerMinute: 2 } })
    const key = lease.keys[PLAYER]
    const setupRequest = {
      model: 'small',
      messages: [{ role: 'user', content: '[stub:retry-success:setup] setup request' }],
    }
    const turnRequest = {
      model: 'small',
      messages: [{ role: 'user', content: '[stub:provider-metadata] turn request' }],
    }
    expect((await request(key, { phase: 'setup' }, '/internal/tick')).status).toBe(200)
    // The upstream reply waits for the marker update, so commit must use the earlier admission.
    beforeSuccess = async () => {
      expect((await request(key, { tick: 9 }, '/internal/tick')).status).toBe(200)
    }
    const setup = await request(key, setupRequest)
    expect(setup.status).toBe(200)
    const setupCompletion = await setup.json()
    expect(setupCompletion).toMatchObject({ model: 'small' })

    expect((await request(key, { tick: 17 }, '/internal/tick')).status).toBe(200)
    beforeSuccess = async () => {
      expect((await request(key, { tick: 18 }, '/internal/tick')).status).toBe(200)
    }
    const turn = await request(key, turnRequest)
    expect(turn.status).toBe(200)
    const turnCompletion = await turn.json()
    expect(turnCompletion).toMatchObject({ model: 'small' })
    expect(turnCompletion).not.toHaveProperty('provider')
    expect(upstream.requests).toHaveLength(4)

    const recorded = {
      sessionId: SCOPE_ID,
      player: PLAYER,
      model: 'small',
      costWeight: 2,
      budgetCostUnits: 6,
      inputTokens: 2,
      reasoningTokens: 0,
      outputTokens: 1,
      usageEstimated: false,
    }
    expect(telemetry.listCalls(SCOPE_ID)).toEqual([
      expect.objectContaining({
        ...recorded,
        tick: null,
        request: { ...setupRequest, max_completion_tokens: 4 },
        completion: setupCompletion,
        latencyMs: 75,
      }),
      expect.objectContaining({
        ...recorded,
        tick: 17,
        request: { ...turnRequest, max_completion_tokens: 4 },
        completion: turnCompletion,
        latencyMs: 25,
      }),
    ])
    expect(telemetry.readSessionUsageByModel(SCOPE_ID, SCOPE_ID, PLAYER)).toEqual({
      small: { calls: 2, inputTokens: 4, reasoningTokens: 0, outputTokens: 2 },
    })
    const limited = await request(key, { model: 'small', messages: [], max_completion_tokens: 1 })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limit_exceeded' } })
    expect(upstream.requests).toHaveLength(4)

    await lease.revoke()
    expect((await request(key, { model: 'small', messages: [] })).status).toBe(401)
    expect((await request(key, { tick: 19 }, '/internal/tick')).status).toBe(401)
  })

  it.each([
    ['non-retryable upstream response', 'non-retryable', 400, 1],
    ['exhausted retryable upstream response', 'retry-exhausted', 503, 3],
  ])('does not charge or write a row after a %s', async (_name, scenario, expectedStatus, attempts) => {
    const scopeId = `${SCOPE_ID}-${scenario}`
    vi.spyOn(tokenizer, 'countRequest').mockReturnValue(2)
    const lease = await issue({
      sessionId: scopeId,
      scopeId,
      limits: { tokenBudget: 12, requestsPerMinute: 1 },
    })
    const key = lease.keys[PLAYER]

    const response = await request(key, {
      model: 'small',
      messages: [{ role: 'user', content: `[stub:${scenario}] terminal request` }],
    })

    expect(response.status).toBe(expectedStatus)
    expect(await response.json()).toMatchObject({
      error: { code: `stub_${expectedStatus}`, type: 'stub_error', message: expect.any(String) },
    })
    expect(upstream.requests).toHaveLength(attempts)
    expect(telemetry.listCalls(scopeId)).toEqual([])
    expect(telemetry.readSessionUsageByModel(scopeId, scopeId, PLAYER)).toEqual({})

    const recovered = await request(key, { model: 'small', messages: [] })
    expect(recovered.status).toBe(200)
    expect(telemetry.listCalls(scopeId)).toMatchObject([
      { sessionId: scopeId, player: PLAYER, model: 'small', budgetCostUnits: 6 },
    ])
    expect(telemetry.readSessionUsageByModel(scopeId, scopeId, PLAYER)).toEqual({
      small: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 1 },
    })
  })

  it('retries a recovered telemetry preflight without spending provider tokens on failure', async () => {
    const lease = await issue()
    const key = lease.keys[PLAYER]
    vi.spyOn(telemetry, 'open').mockImplementationOnce(() => {
      throw new Error('storage temporarily unavailable')
    })

    const failed = await request(key, {
      model: 'small',
      messages: [{ role: 'user', content: '[stub:success] rejected before provider' }],
    })

    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
    expect(upstream.requests).toEqual([])
    expect(telemetry.listCalls(SCOPE_ID)).toEqual([])

    const recovered = await request(key, {
      model: 'small',
      messages: [{ role: 'user', content: '[stub:success] recovered preflight' }],
    })
    expect(recovered.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(telemetry.listCalls(SCOPE_ID)).toHaveLength(1)
  })

  it.each([
    ['token', { tokenBudget: 12, requestsPerMinute: 20 }, 400, 'budget_exceeded'],
    ['rate', { tokenBudget: 100, requestsPerMinute: 1 }, 429, 'rate_limit_exceeded'],
  ] as const)('isolates %s allowances by player and game within one run', async (_name, limits, status, code) => {
    vi.spyOn(tokenizer, 'countRequest').mockReturnValue(2)
    const first = await issue({
      scopeId: 'run-1',
      sessionId: 'game-1',
      agentPlayers: [PLAYER, 'player_0'],
      limits,
    })
    const body = { model: 'small', messages: [] }
    expect((await request(first.keys[PLAYER], body)).status).toBe(200)
    const refused = await request(first.keys[PLAYER], body)
    expect(refused.status).toBe(status)
    expect(await refused.json()).toMatchObject({ error: { code } })
    expect((await request(first.keys.player_0, body)).status).toBe(200)

    const second = await issue({ scopeId: 'run-1', sessionId: 'game-2', limits })
    expect((await request(second.keys[PLAYER], body)).status).toBe(200)
    expect(upstream.requests).toHaveLength(3)
    expect(telemetry.listCalls('run-1')).toMatchObject([
      { sessionId: 'game-1', player: PLAYER, model: 'small', budgetCostUnits: 6 },
      { sessionId: 'game-1', player: 'player_0', model: 'small', budgetCostUnits: 6 },
      { sessionId: 'game-2', player: PLAYER, model: 'small', budgetCostUnits: 6 },
    ])
    for (const [game, player] of [
      ['game-1', PLAYER],
      ['game-1', 'player_0'],
      ['game-2', PLAYER],
    ] as const) {
      expect(telemetry.readSessionUsageByModel('run-1', game, player)).toEqual({
        small: { calls: 1, inputTokens: 2, reasoningTokens: 0, outputTokens: 1 },
      })
    }
  })

  it('fails closed for only the player whose successful call could not commit', async () => {
    const lease = await issue({ agentPlayers: [PLAYER, 'player_0'] })
    const db = new BetterSqlite3(telemetry.pathForScope(SCOPE_ID))
    try {
      db.exec(`
        CREATE TRIGGER fail_call AFTER INSERT ON calls
        BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;
      `)
      const body = { model: 'small', messages: [] }
      const failed = await request(lease.keys[PLAYER], body)
      expect(failed.status).toBe(503)
      expect(await failed.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
      expect(upstream.requests).toHaveLength(1)
      expect(telemetry.listCalls(SCOPE_ID)).toEqual([])
      expect(telemetry.readSessionUsageByModel(SCOPE_ID, SCOPE_ID, PLAYER)).toEqual({})

      db.exec('DROP TRIGGER fail_call')
      const blocked = await request(lease.keys[PLAYER], body)
      expect(blocked.status).toBe(503)
      expect(await blocked.json()).toMatchObject({ error: { code: 'meter_unavailable' } })
      expect(upstream.requests).toHaveLength(1)

      expect((await request(lease.keys.player_0, body)).status).toBe(200)
      expect(telemetry.listCalls(SCOPE_ID)).toMatchObject([
        { sessionId: SCOPE_ID, player: 'player_0', model: 'small', budgetCostUnits: 6 },
      ])
    } finally {
      db.close()
    }
  })
})
