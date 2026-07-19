import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseDevelopmentPagination } from '../../../src/llm/development-views.js'
import {
  DEVELOPMENT_LEDGER_SCHEMA_VERSION,
  type DevelopmentCallInput,
  DevelopmentLedgerStore,
} from '../../../src/storage/llm/development-ledger/index.js'

const CALL: DevelopmentCallInput = {
  userId: 'user-a',
  model: 'small',
  request: { model: 'small', messages: [{ role: 'user', content: 'move?' }] },
  completion: { choices: [{ message: { role: 'assistant', content: 'left' } }] },
  inputTokens: 11,
  reasoningTokens: 2,
  outputTokens: 3,
  usageEstimated: false,
  latencyMs: 25,
  createdAt: '2026-07-15T12:00:00.000Z',
}

describe('DevelopmentLedgerStore', () => {
  let root: string
  let store: DevelopmentLedgerStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gs-llm-development-'))
    store = new DevelopmentLedgerStore(root, () => new Date('2026-07-15T12:34:56.000Z'))
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates the versioned schema, user index, and startup write-health row', () => {
    store.open('season-1')
    const db = new BetterSqlite3(join(root, 'season-1.sqlite'), { readonly: true })

    expect(db.pragma('user_version', { simple: true })).toBe(DEVELOPMENT_LEDGER_SCHEMA_VERSION)
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all(),
    ).toEqual(['calls', 'meter_health'])
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'calls_user'")
        .pluck()
        .get(),
    ).toBe('calls_user')
    expect(db.prepare('SELECT * FROM meter_health').get()).toEqual({
      id: 1,
      checked_at: '2026-07-15T12:34:56.000Z',
    })
    db.close()
  })

  it('round-trips every call field and keeps usage and estimates isolated by participant', () => {
    expect(store.record('season-1', CALL)).toBe(1)
    expect(
      store.record('season-1', {
        ...CALL,
        userId: 'user-b',
        usageEstimated: true,
        inputTokens: 5,
        reasoningTokens: 1,
        outputTokens: 7,
      }),
    ).toBe(2)

    const db = new BetterSqlite3(join(root, 'season-1.sqlite'), { readonly: true })
    expect(db.prepare('SELECT * FROM calls ORDER BY id').all()).toEqual([
      {
        id: 1,
        user_id: 'user-a',
        model: 'small',
        request_json: JSON.stringify(CALL.request),
        completion_json: JSON.stringify(CALL.completion),
        input_tokens: 11,
        reasoning_tokens: 2,
        output_tokens: 3,
        usage_estimated: 0,
        latency_ms: 25,
        created_at: '2026-07-15T12:00:00.000Z',
      },
      expect.objectContaining({
        id: 2,
        user_id: 'user-b',
        usage_estimated: 1,
        input_tokens: 5,
        reasoning_tokens: 1,
        output_tokens: 7,
      }),
    ])
    db.close()

    expect(store.readUserUsageByModel('season-1', 'user-a')).toEqual({
      small: {
        calls: 1,
        inputTokens: 11,
        reasoningTokens: 2,
        outputTokens: 3,
      },
    })
    expect(store.readUserUsageByModel('season-1', 'user-b')).toEqual({
      small: {
        calls: 1,
        inputTokens: 5,
        reasoningTokens: 1,
        outputTokens: 7,
      },
    })
    expect(store.readUserUsageByModel('season-2', 'user-a')).toEqual({})
  })

  it('groups committed usage by model without dropping an unknown stored alias', () => {
    store.record('season-1', CALL)
    store.record('season-1', {
      ...CALL,
      model: 'retired-alias',
      inputTokens: 4,
      reasoningTokens: 0,
      outputTokens: 6,
    })

    expect(store.readUserUsageByModel('season-1', 'user-a')).toEqual({
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
    expect(store.readUserUsageByModel('season-1', 'missing')).toEqual({})
  })

  it('pages one participant newest-first and reports aggregate estimates by participant', () => {
    store.record('season-1', CALL)
    store.record('season-1', { ...CALL, userId: 'user-b', usageEstimated: true })
    store.record('season-1', {
      ...CALL,
      model: 'medium',
      inputTokens: 4,
      reasoningTokens: 0,
      outputTokens: 6,
      usageEstimated: true,
      request: { messages: ['newer'] },
    })
    store.record('season-1', { ...CALL, createdAt: '2026-07-15T13:00:00.000Z' })

    const first = store.listUserCalls('season-1', 'user-a', { limit: 2 })
    expect(first.nextCursor).toBe(3)
    expect(first.calls.map((call) => call.id)).toEqual([4, 3])
    expect(first.calls[1]).toMatchObject({
      userId: 'user-a',
      model: 'medium',
      usageEstimated: true,
      request: { messages: ['newer'] },
      latencyMs: 25,
    })
    const second = store.listUserCalls('season-1', 'user-a', {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    })
    expect(second.nextCursor).toBeNull()
    expect(second.calls.map((call) => call.id)).toEqual([1])
    expect(
      store.listUserCalls('season-1', 'user-b', { limit: 10 }).calls.map((call) => call.id),
    ).toEqual([2])

    expect(store.listParticipantUsage('season-1')).toEqual([
      {
        userId: 'user-a',
        usageEstimated: true,
        usageByModel: {
          medium: { calls: 1, inputTokens: 4, reasoningTokens: 0, outputTokens: 6 },
          small: { calls: 2, inputTokens: 22, reasoningTokens: 4, outputTokens: 6 },
        },
      },
      {
        userId: 'user-b',
        usageEstimated: true,
        usageByModel: {
          small: { calls: 1, inputTokens: 11, reasoningTokens: 2, outputTokens: 3 },
        },
      },
    ])
    expect(store.hasEstimatedUsage('season-1', 'user-a')).toBe(true)
    expect(store.hasEstimatedUsage('season-1', 'missing')).toBe(false)
  })

  it('parses one bounded pagination contract before ledger access', () => {
    expect(parseDevelopmentPagination({})).toEqual({ limit: 25 })
    expect(parseDevelopmentPagination({ cursor: '12', limit: '100' })).toEqual({
      cursor: 12,
      limit: 100,
    })
    expect(parseDevelopmentPagination({ limit: '0' })).toBeNull()
    expect(parseDevelopmentPagination({ limit: '101' })).toBeNull()
    expect(parseDevelopmentPagination({ cursor: '0' })).toBeNull()
    expect(parseDevelopmentPagination({ cursor: '1.5' })).toBeNull()
  })

  it('rejects newer schemas, unsafe season paths, and invalid rows without inserting a call', () => {
    const future = new BetterSqlite3(join(root, 'future.sqlite'))
    future.pragma(`user_version = ${DEVELOPMENT_LEDGER_SCHEMA_VERSION + 1}`)
    future.close()

    expect(() => store.open('future')).toThrow('newer than supported')
    for (const seasonId of ['', '.', '..', '../escape', 'nested/season', 'nested\\season', 'a b']) {
      expect(() => store.open(seasonId)).toThrow('filename-safe')
    }
    expect(() => store.record('season-1', { ...CALL, request: undefined })).toThrow('request')
    expect(() => store.record('season-1', { ...CALL, outputTokens: -1 })).toThrow('outputTokens')
    expect(store.readUserUsageByModel('season-1', 'user-a')).toEqual({})
  })
})
