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
  slot: 'player_0',
  tick: null,
  model: 'small',
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
    store = new ExecutionTelemetryStore(root, () => new Date('2026-07-15T12:34:56.000Z'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the versioned schema and completes startup write health', () => {
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
    ).toEqual(['calls_created_at', 'calls_session_slot'])
    expect(db.prepare('SELECT * FROM meter_health').get()).toEqual({
      id: 1,
      checked_at: '2026-07-15T12:34:56.000Z',
    })
    db.close()
  })

  it('migrates a user-version-zero fixture without losing its call', () => {
    const path = join(root, 'old.sqlite')
    const old = new BetterSqlite3(path)
    old.exec(`
      CREATE TABLE calls (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, slot TEXT NOT NULL,
        tick INTEGER, model TEXT NOT NULL, request_json TEXT NOT NULL, completion_json TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        usage_estimated INTEGER NOT NULL, latency_ms INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO calls VALUES (1, 'old-game', 'player_0', NULL, 'large', '{}', '{}',
        1, 0, 2, 0, 3, '2026-07-01T00:00:00.000Z');
    `)
    old.close()
    store.open('old')
    expect(store.readSessionUsageByModel('old', 'old-game', 'player_0')).toEqual({
      large: {
        calls: 1,
        inputTokens: 1,
        reasoningTokens: 0,
        outputTokens: 2,
      },
    })
    const migrated = new BetterSqlite3(path, { readonly: true })
    expect(migrated.pragma('user_version', { simple: true })).toBe(1)
    expect(
      migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'meter_health'").get(),
    ).toBeDefined()
    migrated.close()
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
      latencyMs: 75,
      usageEstimated: true,
      request: ['full', { nested: true }],
      completion: { choices: [], usage: null },
    })
    store.insert('run', {
      ...CALL,
      slot: 'player_1',
      model: 'large',
      inputTokens: 100,
      reasoningTokens: 20,
      outputTokens: 30,
    })

    expect(store.listCalls('run', { sessionId: 'game-1', slot: 'player_0' })[0]).toEqual({
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

  it('probes health, closes before deleting, and recreates a clean scope', () => {
    store.insert('delete-me', CALL)
    expect(() => store.probeHealth('delete-me')).not.toThrow()
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
    expect(store.listCalls('scope')).toEqual([])
  })
})
