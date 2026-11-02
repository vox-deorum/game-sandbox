import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RecordingHeader } from '@game-sandbox/schema'
import BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { NewSubmissionInput, Storage } from '../../src/storage/index.js'
import { ExecutionTelemetryStore } from '../../src/storage/llm/execution-telemetry.js'
import { openTestApp, type TestApp } from '../support/harness.js'

// The ordinary single-player header most recordings share; the ownership test builds a richer one.
const HEADER: RecordingHeader = {
  schema_version: 1,
  environment: 'flappy_bird',
  parameters: {},
  players: { player_0: { kind: 'agent', builtin_name: 'naive', label: 'Naive agent' } },
  seats: { seat_0: ['player_0'] },
  seat_plan: 'solo',
}
const BODIES = {
  request: { model: 'small', messages: [{ role: 'user', content: 'move?' }] },
  completion: { model: 'small', choices: [{ message: { content: 'left' } }] },
}
const SMALL_PUBLIC = {
  tick: null,
  player: 'player_0',
  model: 'small',
  input_tokens: 2,
  reasoning_tokens: 1,
  output_tokens: 2,
  usage_estimated: false,
  cost_weight: 1.5,
  budget_cost_units: 6,
}

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
      player: 'player_0',
      tick: null,
      model: 'small',
      costWeight: 1.5,
      budgetCostUnits: 6,
      ...BODIES,
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

    await fixture.users.headersFor('recorder')
    await seedRecording('ordinary', HEADER, null)
    const ordinary = await app.inject({ method: 'GET', url: '/api/recordings/ordinary/llm' })
    expect(ordinary.statusCode).toBe(200)
    expect(ordinary.json()).toEqual({ calls: [], total_budget_cost_units: 0 })

    telemetry.open('empty-scope')
    await seedRecording('associated-empty', HEADER, {
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

  it('distinguishes broken associated telemetry from a successful empty result', async () => {
    await fixture.users.headersFor('recorder')
    for (const [id, fault] of [
      ['future', 'PRAGMA user_version = 2'],
      ['missing-cost', 'ALTER TABLE calls DROP COLUMN cost_weight'],
      ['wrong-cost', 'UPDATE calls SET budget_cost_units = 99'],
    ] as const) {
      insertCall(id, 'session')
      telemetry.closeScope(id)
      const db = new BetterSqlite3(telemetry.pathForScope(id))
      try {
        db.exec(fault)
      } finally {
        db.close()
      }
    }
    await writeFile(telemetry.pathForScope('unreadable'), 'not a SQLite database')
    for (const id of ['missing', 'unreadable', 'future', 'missing-cost', 'wrong-cost']) {
      await seedRecording(id, HEADER, { scopeId: id, sessionId: 'session' })
      const response = await app.inject({ method: 'GET', url: `/api/recordings/${id}/llm` })
      expect(response.statusCode, id).toBe(500)
      expect(response.json(), id).toMatchObject({ code: 'telemetry_unavailable' })
    }
  })

  it('orders public metadata and reveals each body only to its current owner or an operator', async () => {
    const alice = await seedSubmission('alice')
    const bob = await seedSubmission('bob')
    await fixture.users.headersFor('recorder')
    const alicePlayer = {
      kind: 'agent' as const,
      label: 'Alice',
      user: alice.user_id,
      submission_id: alice.id,
    }
    await seedRecording(
      'multi',
      {
        ...HEADER,
        players: {
          player_0: alicePlayer,
          player_1: { kind: 'agent', label: 'Bob', user: bob.user_id, submission_id: bob.id },
          player_2: alicePlayer,
        },
        seats: { seat_0: ['player_0', 'player_2'], seat_1: ['player_1'] },
      },
      { scopeId: 'run-scope', sessionId: 'game-1' },
    )
    const bobBodies = {
      request: { model: 'medium', messages: ['bob prompt'] },
      completion: { model: 'medium', choices: ['bob answer'] },
    }
    const otherBodies = {
      request: { model: 'small', messages: ['second player prompt'] },
      completion: { model: 'small', choices: ['second player answer'] },
    }
    insertCall('run-scope', 'game-1', {
      player: 'player_1',
      model: 'medium',
      costWeight: 2,
      budgetCostUnits: 20,
      inputTokens: 3,
      reasoningTokens: 2,
      outputTokens: 7,
      usageEstimated: true,
      ...bobBodies,
    })
    insertCall('run-scope', 'game-1', { tick: 9 })
    insertCall('run-scope', 'game-1', { player: 'player_2', tick: 0, ...otherBodies })
    insertCall('run-scope', 'another-game', { player: 'player_0' })

    const bobPublic = {
      tick: null,
      player: 'player_1',
      model: 'medium',
      input_tokens: 3,
      reasoning_tokens: 2,
      output_tokens: 7,
      usage_estimated: true,
      cost_weight: 2,
      budget_cost_units: 20,
    }
    const alicePublic = { ...SMALL_PUBLIC, tick: 9 }
    const aliceOtherPublic = { ...alicePublic, player: 'player_2', tick: 0 }
    const publicCalls = [bobPublic, alicePublic, aliceOtherPublic]
    const bobCall = { ...bobPublic, ...bobBodies }
    const aliceCall = { ...alicePublic, ...BODIES }
    const aliceOtherCall = { ...aliceOtherPublic, ...otherBodies }
    for (const [name, headers, calls] of [
      ['anonymous', undefined, publicCalls],
      ['non-owner', await fixture.users.headersFor('recorder'), publicCalls],
      ['alice', await fixture.users.headersFor('alice'), [bobPublic, aliceCall, aliceOtherCall]],
      ['bob', await fixture.users.headersFor('bob'), [bobCall, alicePublic, aliceOtherPublic]],
      [
        'operator',
        await fixture.users.headersFor('operator', { status: 'admin' }),
        [bobCall, aliceCall, aliceOtherCall],
      ],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/recordings/multi/llm?user_id=${alice.user_id}&submission_id=${alice.id}`,
        headers,
      })
      expect(response.statusCode, name).toBe(200)
      expect(response.json(), name).toEqual({ calls, total_budget_cost_units: 32 })
    }
    await storage.updateSeasonConfig(seasonId, {
      deps_version: 1,
      matches: [],
      overrides: {
        llm: { enabled: true, models: ['small', 'medium'], cost_weights: { small: 7, medium: 9 } },
      },
    })
    expect(JSON.parse((await storage.getSeason(seasonId))?.config ?? '{}')).toMatchObject({
      overrides: { llm: { cost_weights: { small: 7, medium: 9 } } },
    })
    const repriced = await app.inject({ method: 'GET', url: '/api/recordings/multi/llm' })
    expect(repriced.statusCode).toBe(200)
    expect(repriced.json()).toEqual({ calls: publicCalls, total_budget_cost_units: 32 })
  })

  it('revokes former-owner body access after real submission deletion while retaining telemetry', async () => {
    const alice = await seedSubmission('alice')
    await fixture.users.headersFor('recorder')
    const header: RecordingHeader = {
      ...HEADER,
      players: {
        player_0: { kind: 'agent', label: 'Alice', user: alice.user_id, submission_id: alice.id },
      },
    }
    await seedRecording('retained', header, { scopeId: 'retained', sessionId: 'session' })
    insertCall('retained', 'session')
    const owner = await fixture.users.headersFor('alice')
    const read = async (headers: Record<string, string>) => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/recordings/retained/llm',
        headers,
      })
      expect(response.statusCode).toBe(200)
      return response.json()
    }
    const full = { calls: [{ ...SMALL_PUBLIC, ...BODIES }], total_budget_cost_units: 6 }
    expect(await read(owner)).toEqual(full)
    await storage.deleteSubmissionsForSeason(seasonId)
    expect(await storage.getRecording('retained')).toMatchObject({
      llm_scope_id: 'retained',
      llm_session_id: 'session',
    })
    expect(existsSync(telemetry.pathForScope('retained'))).toBe(true)
    expect(await fixture.recordings.readHeader('retained')).toEqual(header)
    expect(await read(owner)).toEqual({ calls: [SMALL_PUBLIC], total_budget_cost_units: 6 })
    expect(await read(await fixture.users.headersFor('operator', { status: 'admin' }))).toEqual(
      full,
    )
  })
})
