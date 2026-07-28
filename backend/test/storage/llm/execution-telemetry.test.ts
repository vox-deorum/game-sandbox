import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  EXECUTION_TELEMETRY_SCHEMA_VERSION,
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
  let now: Date

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gs-llm-telemetry-'))
    now = new Date('2026-07-15T12:34:56.000Z')
    store = new ExecutionTelemetryStore(root, () => now)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the versioned schema and verifies startup writes', () => {
    store.open('scope-1')
    const db = new BetterSqlite3(join(root, 'scope-1.sqlite'), { readonly: true })
    expect(db.pragma('user_version', { simple: true })).toBe(EXECUTION_TELEMETRY_SCHEMA_VERSION)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all(),
    ).toEqual(['calls', 'meter_health'])
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'calls_%' ORDER BY name",
        )
        .pluck()
        .all(),
    ).toEqual(['calls_created_at', 'calls_session_player'])
    expect(db.prepare('SELECT * FROM meter_health').get()).toEqual({
      id: 1,
      checked_at: '2026-07-15T12:34:56.000Z',
    })
    db.close()
  })

  it('rechecks writes when admission explicitly opens a cached scope', () => {
    store.open('scope-1')
    now = new Date('2026-07-15T12:35:56.000Z')
    store.open('scope-1')

    const db = new BetterSqlite3(join(root, 'scope-1.sqlite'), { readonly: true })
    expect(db.prepare('SELECT checked_at FROM meter_health WHERE id = 1').pluck().get()).toBe(
      '2026-07-15T12:35:56.000Z',
    )
    db.close()
  })

  it('refuses a cached scope whose durable write no longer commits', () => {
    store.open('scope-1')
    const broken = new BetterSqlite3(join(root, 'scope-1.sqlite'))
    broken.exec('DROP TABLE meter_health')
    broken.close()

    expect(() => store.open('scope-1')).toThrow('meter_health')
  })

  it('rejects newer schemas', () => {
    const future = new BetterSqlite3(join(root, 'future.sqlite'))
    future.pragma(`user_version = ${EXECUTION_TELEMETRY_SCHEMA_VERSION + 1}`)
    future.close()
    expect(() => store.open('future')).toThrow('newer than supported')
  })

  it('round-trips full rows and returns exact usage and aggregates', () => {
    expect(store.record('run', CALL)).toBe(1)
    store.insert('run', {
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
    })
    store.insert('run', {
      ...CALL,
      player: 'player_1',
      model: 'large',
      inputTokens: 100,
      reasoningTokens: 20,
      outputTokens: 30,
      budgetCostUnits: 195,
    })

    expect(store.listCalls('run', { sessionId: 'game-1', player: 'player_0' })[0]).toEqual({
      id: 1,
      ...CALL,
    })
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

  it.each([
    '',
    '.',
    '..',
    '../escape',
    'nested/scope',
    'nested\\scope',
    'scope.sqlite',
    'a b',
    'é',
  ])('rejects unsafe scope id %j', (scopeId) => {
    expect(() => store.open(scopeId)).toThrow('filename-safe')
  })

  it('validates numeric and JSON fields before insertion', () => {
    expect(() => store.insert('scope', { ...CALL, inputTokens: -1 })).toThrow('inputTokens')
    expect(() => store.insert('scope', { ...CALL, tick: 1.5 })).toThrow('tick')
    expect(() => store.insert('scope', { ...CALL, request: undefined })).toThrow('request')
    expect(() => store.insert('scope', { ...CALL, costWeight: 0 })).toThrow('costWeight')
    expect(() => store.insert('scope', { ...CALL, costWeight: Number.POSITIVE_INFINITY })).toThrow(
      'costWeight',
    )
    expect(() => store.insert('scope', { ...CALL, budgetCostUnits: 20 })).toThrow('exactly match')
    expect(store.listCalls('scope')).toEqual([])
  })

  it('reads retained rows without mutating the associated file', () => {
    store.insert('retained', CALL)
    store.insert('retained', { ...CALL, sessionId: 'other', budgetCostUnits: 21 })
    store.closeScope('retained')

    expect(store.readAssociatedCalls('retained', 'game-1')).toEqual([{ id: 1, ...CALL }])
  })

  it('rejects missing and legacy associated files without creating or migrating them', () => {
    const missing = join(root, 'missing.sqlite')
    expect(() => store.readAssociatedCalls('missing', 'game-1')).toThrow('missing')
    expect(existsSync(missing)).toBe(false)

    const legacyPath = join(root, 'legacy.sqlite')
    const legacy = new BetterSqlite3(legacyPath)
    legacy.exec(`
      CREATE TABLE calls (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, player TEXT NOT NULL,
        tick INTEGER, model TEXT NOT NULL, request_json TEXT NOT NULL, completion_json TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        usage_estimated INTEGER NOT NULL, latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL
      );
    `)
    legacy.close()

    expect(() => store.readAssociatedCalls('legacy', 'game-1')).toThrow('unavailable')
    const unchanged = new BetterSqlite3(legacyPath, { readonly: true })
    expect(unchanged.pragma('user_version', { simple: true })).toBe(0)
    expect(unchanged.prepare('PRAGMA table_info(calls)').all()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'cost_weight' })]),
    )
    unchanged.close()
  })
})
