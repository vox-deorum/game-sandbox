import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RecordingHeader } from '@game-sandbox/schema'
import BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RecordingPublicLlmCall } from '../../src/llm/recording-routes.js'
import type { NewSubmissionInput, Storage } from '../../src/storage/index.js'
import { ExecutionTelemetryStore } from '../../src/storage/llm/execution-telemetry.js'
import { openTestApp, type TestApp } from '../support/harness.js'

describe('recording LLM telemetry API', () => {
  let app: FastifyInstance
  let fixture: TestApp
  let storage: Storage
  let telemetry: ExecutionTelemetryStore
  let telemetryRoot: string
  let seasonId: string

  beforeEach(async () => {
    telemetryRoot = mkdtempSync(join(tmpdir(), 'gs-recording-llm-'))
    telemetry = new ExecutionTelemetryStore(telemetryRoot)
    fixture = await openTestApp({ officialTelemetry: telemetry })
    app = fixture.app
    storage = fixture.storage
    seasonId = (await storage.ensureOpenSeason('flappy_bird', 1)).id
  })

  afterEach(async () => {
    await fixture.close()
    telemetry.close()
    rmSync(telemetryRoot, { recursive: true, force: true })
  })

  async function seedSubmission(name: string) {
    await fixture.users.headersFor(name)
    const input: NewSubmissionInput = {
      season_id: seasonId,
      env_id: 'flappy_bird',
      user_id: fixture.users.idOf(name),
      source_kind: 'git',
      repo_url: `https://example.com/${name}/agent.git`,
      commit_sha: null,
      local_path: null,
      ref: null,
      created_at: '2026-07-19T00:00:00.000Z',
    }
    return storage.createSubmission(input)
  }

  async function seedRecording(
    id: string,
    header: RecordingHeader,
    association: { scopeId: string; sessionId: string } | null,
  ): Promise<void> {
    await mkdir(join(fixture.config.recordingsDir, id), { recursive: true })
    await writeFile(
      join(fixture.config.recordingsDir, id, 'recording.jsonl'),
      `${JSON.stringify(header)}\n`,
      'utf8',
    )
    await storage.createRecording({
      id,
      user_id: fixture.users.idOf('recorder'),
      env_id: 'flappy_bird',
      created_at: '2026-07-19T00:00:00.000Z',
      llm_scope_id: association?.scopeId ?? null,
      llm_session_id: association?.sessionId ?? null,
    })
  }

  function insertCall(
    scopeId: string,
    sessionId: string,
    overrides: Partial<Parameters<ExecutionTelemetryStore['insert']>[1]> = {},
  ): void {
    telemetry.insert(scopeId, {
      sessionId,
      slot: 'player_0',
      tick: null,
      model: 'small',
      costWeight: 1.5,
      budgetCostUnits: 6,
      request: { model: 'small', messages: [{ role: 'user', content: 'move?' }] },
      completion: { model: 'small', choices: [{ message: { content: 'left' } }] },
      inputTokens: 2,
      reasoningTokens: 1,
      outputTokens: 2,
      usageEstimated: false,
      latencyMs: 91,
      ...overrides,
    })
  }

  it('returns not found and both ordinary successful empty envelopes', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/recordings/missing/llm' })
    expect(missing.statusCode).toBe(404)

    const header: RecordingHeader = { schema_version: 1, environment: 'flappy_bird' }
    await fixture.users.headersFor('recorder')
    await seedRecording('ordinary', header, null)
    const ordinary = await app.inject({ method: 'GET', url: '/api/recordings/ordinary/llm' })
    expect(ordinary.statusCode).toBe(200)
    expect(ordinary.json()).toEqual({ calls: [], total_budget_cost_units: 0 })

    telemetry.open('empty-scope')
    await seedRecording('associated-empty', header, {
      scopeId: 'empty-scope',
      sessionId: 'empty-session',
    })
    const associated = await app.inject({
      method: 'GET',
      url: '/api/recordings/associated-empty/llm',
    })
    expect(associated.statusCode).toBe(200)
    expect(associated.json()).toEqual({ calls: [], total_budget_cost_units: 0 })
  })

  it('returns telemetry_unavailable for missing, legacy, and incomplete associated telemetry', async () => {
    await fixture.users.headersFor('recorder')
    const header: RecordingHeader = { schema_version: 1, environment: 'flappy_bird' }
    await seedRecording('missing-file', header, { scopeId: 'gone', sessionId: 'session' })

    const legacy = new BetterSqlite3(telemetry.pathForScope('legacy'))
    legacy.pragma('user_version = 1')
    legacy.close()
    await seedRecording('legacy-file', header, { scopeId: 'legacy', sessionId: 'session' })

    const incomplete = new BetterSqlite3(telemetry.pathForScope('incomplete'))
    incomplete.exec(`
      CREATE TABLE calls (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, slot TEXT NOT NULL,
        tick INTEGER, model TEXT NOT NULL, request_json TEXT NOT NULL, completion_json TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        usage_estimated INTEGER NOT NULL, latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO calls VALUES (
        1, 'session', 'player_0', NULL, 'small', '{}', '{}', 1, 0, 1, 0, 4,
        '2026-07-19T00:00:00.000Z'
      );
    `)
    incomplete.close()
    telemetry.open('incomplete')
    telemetry.closeScope('incomplete')
    await seedRecording('incomplete-file', header, {
      scopeId: 'incomplete',
      sessionId: 'session',
    })

    for (const id of ['missing-file', 'legacy-file', 'incomplete-file']) {
      const response = await app.inject({ method: 'GET', url: `/api/recordings/${id}/llm` })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({
        error: 'recording telemetry is unavailable',
        code: 'telemetry_unavailable',
      })
    }
  })

  it('orders public metadata and reveals each body only to its current owner or an operator', async () => {
    const alice = await seedSubmission('alice')
    const bob = await seedSubmission('bob')
    await fixture.users.headersFor('recorder')
    const header: RecordingHeader = {
      schema_version: 1,
      environment: 'flappy_bird',
      players: {
        player_0: {
          kind: 'agent',
          label: "alice's agent",
          user: alice.user_id,
          submission_id: alice.id,
        },
        player_1: {
          kind: 'agent',
          label: "bob's agent",
          user: bob.user_id,
          submission_id: bob.id,
        },
        player_2: {
          kind: 'agent',
          label: 'deleted agent',
          user: alice.user_id,
          submission_id: 'deleted-submission',
        },
      },
    }
    await seedRecording('multi', header, { scopeId: 'run-scope', sessionId: 'game-1' })
    insertCall('run-scope', 'game-1', {
      slot: 'player_1',
      model: 'medium',
      costWeight: 2,
      budgetCostUnits: 20,
      inputTokens: 3,
      reasoningTokens: 2,
      outputTokens: 7,
      usageEstimated: true,
      request: { model: 'medium', messages: ['bob prompt'] },
      completion: { model: 'medium', choices: ['bob answer'] },
    })
    insertCall('run-scope', 'game-1', { tick: 9 })
    insertCall('run-scope', 'game-1', {
      slot: 'player_2',
      tick: 10,
      request: { model: 'small', messages: ['former owner prompt'] },
      completion: { model: 'small', choices: ['former owner answer'] },
    })
    insertCall('run-scope', 'another-game', { slot: 'player_0' })

    const anonymous = await app.inject({ method: 'GET', url: '/api/recordings/multi/llm' })
    expect(anonymous.statusCode).toBe(200)
    expect(anonymous.json()).toEqual({
      calls: [
        {
          tick: null,
          slot: 'player_1',
          model: 'medium',
          input_tokens: 3,
          reasoning_tokens: 2,
          output_tokens: 7,
          usage_estimated: true,
          cost_weight: 2,
          budget_cost_units: 20,
        },
        {
          tick: 9,
          slot: 'player_0',
          model: 'small',
          input_tokens: 2,
          reasoning_tokens: 1,
          output_tokens: 2,
          usage_estimated: false,
          cost_weight: 1.5,
          budget_cost_units: 6,
        },
        {
          tick: 10,
          slot: 'player_2',
          model: 'small',
          input_tokens: 2,
          reasoning_tokens: 1,
          output_tokens: 2,
          usage_estimated: false,
          cost_weight: 1.5,
          budget_cost_units: 6,
        },
      ],
      total_budget_cost_units: 32,
    })
    expect(anonymous.body).not.toContain('latency')

    const aliceView = await app.inject({
      method: 'GET',
      url: '/api/recordings/multi/llm',
      headers: await fixture.users.headersFor('alice'),
    })
    const aliceCalls = (aliceView.json() as { calls: RecordingPublicLlmCall[] }).calls
    expect(aliceCalls[0]).not.toHaveProperty('request')
    expect(aliceCalls[1]).toMatchObject({ request: { model: 'small' } })
    expect(aliceCalls[2]).not.toHaveProperty('request')

    const bobView = await app.inject({
      method: 'GET',
      url: '/api/recordings/multi/llm',
      headers: await fixture.users.headersFor('bob'),
    })
    const bobCalls = (bobView.json() as { calls: RecordingPublicLlmCall[] }).calls
    expect(bobCalls[0]).toMatchObject({ request: { model: 'medium' } })
    expect(bobCalls[1]).not.toHaveProperty('request')

    const operator = await app.inject({
      method: 'GET',
      url: '/api/recordings/multi/llm',
      headers: await fixture.users.headersFor('operator', { status: 'admin' }),
    })
    const operatorCalls = (operator.json() as { calls: RecordingPublicLlmCall[] }).calls
    expect(operatorCalls.every((call) => Object.hasOwn(call, 'request'))).toBe(true)
    expect(operatorCalls.every((call) => Object.hasOwn(call, 'completion'))).toBe(true)
  })
})
