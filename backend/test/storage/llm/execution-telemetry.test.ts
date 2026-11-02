import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  type ExecutionTelemetryCallInput,
  ExecutionTelemetryStore,
} from '../../../src/storage/llm/execution-telemetry.js'

const CALL: ExecutionTelemetryCallInput = {
  sessionId: 'game-1',
  player: 'player_0',
  tick: null,
  model: 'small',
  costWeight: 1.5,
  budgetCostUnits: 21,
  request: { model: 'small', messages: [{ role: 'user', content: 'move?' }] },
  completion: { choices: [{ message: { content: 'left' } }] },
  inputTokens: 11,
  reasoningTokens: 2,
  outputTokens: 3,
  usageEstimated: false,
  latencyMs: 25,
  createdAt: '2026-07-15T12:00:00.000Z',
}

describe('ExecutionTelemetryStore', () => {
  let root: string
  let store: ExecutionTelemetryStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gs-llm-telemetry-'))
    store = new ExecutionTelemetryStore(root)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a cached scope whose durable write no longer commits', () => {
    store.open('scope-1')
    store.insert('scope-1', CALL)
    const broken = new BetterSqlite3(join(root, 'scope-1.sqlite'))
    broken.exec('DROP TABLE meter_health')
    broken.close()

    expect(() => store.open('scope-1')).toThrow(BetterSqlite3.SqliteError)
    expect(store.listCalls('scope-1')).toEqual([expect.objectContaining(CALL)])
  })

  it('rejects a newer populated schema without discarding its data', () => {
    store.insert('future', CALL)
    store.closeScope('future')
    const future = new BetterSqlite3(join(root, 'future.sqlite'))
    try {
      future.pragma('user_version = 2')
      expect(() => store.open('future')).toThrow()
      expect(future.pragma('user_version', { simple: true })).toBe(2)
      expect(future.prepare('SELECT session_id, budget_cost_units FROM calls').all()).toEqual([
        { session_id: 'game-1', budget_cost_units: 21 },
      ])
    } finally {
      future.close()
    }
  })

  it('round-trips full rows and returns exact usage and aggregates', () => {
    const estimated = {
      ...CALL,
      sessionId: 'game-2',
      tick: 7,
      inputTokens: 5,
      reasoningTokens: 1,
      outputTokens: 7,
      budgetCostUnits: 18,
      latencyMs: 75,
      usageEstimated: true,
      request: ['full', { nested: true }],
      completion: { choices: [], usage: null },
    }
    const otherPlayer = {
      ...CALL,
      player: 'player_1',
      model: 'large',
      inputTokens: 100,
      reasoningTokens: 20,
      outputTokens: 30,
      budgetCostUnits: 195,
    }
    store.insert('run', CALL)
    store.insert('run', estimated)
    store.insert('run', otherPlayer)
    store.close()
    store = new ExecutionTelemetryStore(root)

    const path = join(root, 'run.sqlite')
    const before = readFileSync(path)
    expect(store.readAssociatedCalls('run', 'game-1')).toEqual([
      { id: 1, ...CALL },
      { id: 3, ...otherPlayer },
    ])
    expect(readFileSync(path)).toEqual(before)
    expect(store.listCalls('run')).toEqual([
      { id: 1, ...CALL },
      { id: 2, ...estimated },
      { id: 3, ...otherPlayer },
    ])
    expect(store.readSessionUsageByModel('run', 'game-1', 'player_0')).toEqual({
      small: {
        calls: 1,
        inputTokens: 11,
        reasoningTokens: 2,
        outputTokens: 3,
      },
    })
    expect(store.readSessionUsageByModel('run', 'missing', 'player_0')).toEqual({})
    expect(store.aggregateByModel('run')).toEqual({
      large: {
        calls: 1,
        estimatedCalls: 0,
        inputTokens: 100,
        reasoningTokens: 20,
        outputTokens: 30,
        latencyMs: 25,
      },
      small: {
        calls: 2,
        estimatedCalls: 1,
        inputTokens: 16,
        reasoningTokens: 3,
        outputTokens: 10,
        latencyMs: 100,
      },
    })
    expect(store.aggregateByModel('run', { sessionId: 'game-1', player: 'player_0' })).toEqual({
      small: {
        calls: 1,
        estimatedCalls: 0,
        inputTokens: 11,
        reasoningTokens: 2,
        outputTokens: 3,
        latencyMs: 25,
      },
    })
  })

  it('groups committed usage by model without dropping an unknown stored alias', () => {
    store.insert('run', CALL)
    store.insert('run', {
      ...CALL,
      model: 'retired-alias',
      inputTokens: 4,
      reasoningTokens: 0,
      outputTokens: 6,
      budgetCostUnits: 15,
    })

    expect(store.readSessionUsageByModel('run', 'game-1', 'player_0')).toEqual({
      'retired-alias': {
        calls: 1,
        inputTokens: 4,
        reasoningTokens: 0,
        outputTokens: 6,
      },
      small: {
        calls: 1,
        inputTokens: 11,
        reasoningTokens: 2,
        outputTokens: 3,
      },
    })
    expect(store.readSessionUsageByModel('run', 'missing', 'player_0')).toEqual({})
  })

  it('closes before deleting and recreates a clean scope', () => {
    store.insert('delete-me', CALL)
    const path = store.pathForScope('delete-me')
    store.deleteScope('delete-me')
    expect(existsSync(path)).toBe(false)
    store.open('delete-me')
    expect(store.listCalls('delete-me')).toEqual([])
  })

  it.each(['', '../escape', 'nested\\scope', 'é'])('rejects unsafe scope id %j', (scopeId) => {
    expect(() => store.open(scopeId)).toThrow()
  })

  it('validates numeric and JSON fields before insertion', () => {
    expect(() => store.insert('scope', { ...CALL, inputTokens: -1, budgetCostUnits: 3 })).toThrow()
    expect(() => store.insert('scope', { ...CALL, tick: 1.5 })).toThrow()
    expect(() => store.insert('scope', { ...CALL, request: undefined })).toThrow()
    expect(() => store.insert('scope', { ...CALL, costWeight: 0, budgetCostUnits: 0 })).toThrow()
    expect(() => store.insert('scope', { ...CALL, costWeight: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => store.insert('scope', { ...CALL, budgetCostUnits: 20 })).toThrow()
    expect(store.listCalls('scope')).toEqual([])
  })

  it('rejects missing and legacy associated files without creating or migrating them', () => {
    const missing = join(root, 'missing.sqlite')
    expect(() => store.readAssociatedCalls('missing', 'game-1')).toThrow()
    expect(existsSync(missing)).toBe(false)

    const legacyPath = join(root, 'legacy.sqlite')
    store.insert('legacy', CALL)
    store.closeScope('legacy')
    const legacy = new BetterSqlite3(legacyPath)
    try {
      legacy.exec('ALTER TABLE calls DROP COLUMN cost_weight')
      legacy.pragma('user_version = 0')
    } finally {
      legacy.close()
    }
    const before = readFileSync(legacyPath)
    expect(() => store.readAssociatedCalls('legacy', 'game-1')).toThrow()
    expect(readFileSync(legacyPath)).toEqual(before)
  })
})
