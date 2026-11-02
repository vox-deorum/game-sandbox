import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
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
    store = new DevelopmentLedgerStore(root)
  })

  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a cached ledger whose durable write no longer commits', () => {
    store.open('season-1')
    store.record('season-1', CALL)
    const broken = new BetterSqlite3(join(root, 'season-1.sqlite'))
    broken.exec('DROP TABLE meter_health')
    broken.close()

    expect(() => store.open('season-1')).toThrow(BetterSqlite3.SqliteError)
    expect(store.listUserCalls('season-1', 'user-a', { limit: 25 }).calls).toEqual([
      expect.objectContaining(CALL),
    ])
  })

  it('round-trips exact public call fields and keeps participant usage isolated after reopening', () => {
    const other: DevelopmentCallInput = {
      ...CALL,
      userId: 'user-b',
      model: 'medium',
      request: { model: 'medium', messages: [{ role: 'user', content: 'other?' }] },
      completion: { choices: [{ message: { role: 'assistant', content: 'right' } }] },
      inputTokens: 5,
      reasoningTokens: 1,
      outputTokens: 7,
      usageEstimated: true,
      latencyMs: 40,
      createdAt: '2026-07-16T08:30:00.000Z',
    }
    store.record('season-1', CALL)
    store.record('season-1', other)
    store.close()
    store = new DevelopmentLedgerStore(root)

    expect(store.listUserCalls('season-1', 'user-a', { limit: 25 })).toEqual({
      calls: [{ ...CALL, id: 1 }],
      nextCursor: null,
    })
    expect(store.listUserCalls('season-1', 'user-b', { limit: 25 })).toEqual({
      calls: [{ ...other, id: 2 }],
      nextCursor: null,
    })
    expect(store.readUserUsageByModel('season-1', 'user-a')).toEqual({
      small: {
        calls: 1,
        inputTokens: 11,
        reasoningTokens: 2,
        outputTokens: 3,
      },
    })
    expect(store.readUserUsageByModel('season-1', 'user-b')).toEqual({
      medium: {
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

  it('pages in insertion order despite timestamps and keeps estimates per participant', () => {
    store.record('season-1', CALL)
    store.record('season-1', {
      ...CALL,
      userId: 'user-b',
      createdAt: '2026-07-15T07:00:00.000Z',
    })
    store.record('season-1', {
      ...CALL,
      model: 'medium',
      inputTokens: 4,
      reasoningTokens: 0,
      outputTokens: 6,
      usageEstimated: true,
      createdAt: '2026-07-15T09:00:00.000Z',
    })
    store.record('season-1', { ...CALL, createdAt: '2026-07-15T08:00:00.000Z' })

    // Timestamps disagree with insertion order, so only reverse id yields [4, 3] then [1].
    const first = store.listUserCalls('season-1', 'user-a', { limit: 2 })
    expect(first.nextCursor).toBe(3)
    expect(first.calls.map((call) => call.id)).toEqual([4, 3])
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
        usageEstimated: false,
        usageByModel: {
          small: { calls: 1, inputTokens: 11, reasoningTokens: 2, outputTokens: 3 },
        },
      },
    ])
    expect(store.hasEstimatedUsage('season-1', 'user-a')).toBe(true)
    expect(store.hasEstimatedUsage('season-1', 'user-b')).toBe(false)
  })

  it('rejects newer schemas and unsafe inputs without inserting calls or changing the file', () => {
    store.record('future', CALL)
    store.close()
    store = new DevelopmentLedgerStore(root)
    const futurePath = join(root, 'future.sqlite')
    const future = new BetterSqlite3(futurePath)
    future.pragma('user_version = 2')
    future.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('retained')")
    future.close()

    expect(() => store.open('future')).toThrow()
    const inspected = new BetterSqlite3(futurePath, { readonly: true })
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(2)
      expect(inspected.prepare('SELECT value FROM sentinel').all()).toEqual([{ value: 'retained' }])
    } finally {
      inspected.close()
    }

    for (const seasonId of ['', '.', '..', '../escape', 'nested/season', 'nested\\season', 'a b']) {
      expect(() => store.open(seasonId)).toThrow()
    }
    expect(() => store.record('season-1', { ...CALL, request: undefined })).toThrow()
    expect(() => store.record('season-1', { ...CALL, outputTokens: -1 })).toThrow()
    expect(store.readUserUsageByModel('season-1', 'user-a')).toEqual({})
  })
})
