/** Successful development calls, stored in one SQLite ledger per season and keyed by participant. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'

import type { LlmUsage } from '../../../llm/types.js'

const CURRENT_SCHEMA_VERSION = 1
const SEASON_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface DevelopmentCallInput {
  userId: string
  model: string
  request: unknown
  completion: unknown
  inputTokens: number
  reasoningTokens: number
  outputTokens: number
  usageEstimated: boolean
  latencyMs: number
  createdAt?: string
}

export interface DevelopmentCall extends Required<DevelopmentCallInput> {
  id: number
}

export interface DevelopmentCallPage {
  calls: DevelopmentCall[]
  nextCursor: number | null
}

export interface DevelopmentParticipantUsage {
  userId: string
  usageByModel: Record<string, LlmUsage>
  usageEstimated: boolean
}

interface LedgerHandle {
  db: BetterSqlite3.Database
  insertCall: BetterSqlite3.Statement
  userUsageByModel: BetterSqlite3.Statement
}

interface CallRow {
  id: number
  user_id: string
  model: string
  request_json: string
  completion_json: string
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  usage_estimated: number
  latency_ms: number
  created_at: string
}

interface UsageRow {
  calls: number
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
}

interface ParticipantUsageRow extends UsageRow {
  user_id: string
  model: string
  estimated_calls: number
}

function validateSeasonId(seasonId: string): void {
  if (!SEASON_ID.test(seasonId)) {
    throw new Error('LLM development season id must be filename-safe ASCII')
  }
}

function encodeJson(value: unknown, name: string): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error(`${name} must be JSON-serializable`)
  return encoded
}

function assertValue(value: string, name: string): void {
  if (value.length === 0) throw new Error(`${name} must not be empty`)
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`)
}

function migrate(db: BetterSqlite3.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `LLM development schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    )
  }
  if (version < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE calls (
          id INTEGER PRIMARY KEY,
          user_id TEXT NOT NULL,
          model TEXT NOT NULL,
          request_json TEXT NOT NULL,
          completion_json TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          reasoning_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          usage_estimated INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX calls_user ON calls (user_id, id);
        CREATE TABLE meter_health (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          checked_at TEXT NOT NULL
        );
      `)
      db.pragma('user_version = 1')
    }).immediate()
  }
}

function writeHealth(db: BetterSqlite3.Database, checkedAt: string): void {
  db.transaction(() => {
    db.prepare(`INSERT INTO meter_health (id, checked_at) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at`).run(checkedAt)
    const row = db.prepare('SELECT checked_at FROM meter_health WHERE id = 1').get() as
      | { checked_at: string }
      | undefined
    if (row?.checked_at !== checkedAt)
      throw new Error('LLM development write-health readback failed')
  }).immediate()
}

function decodeCall(row: CallRow): DevelopmentCall {
  return {
    id: row.id,
    userId: row.user_id,
    model: row.model,
    request: JSON.parse(row.request_json) as unknown,
    completion: JSON.parse(row.completion_json) as unknown,
    inputTokens: row.input_tokens,
    reasoningTokens: row.reasoning_tokens,
    outputTokens: row.output_tokens,
    usageEstimated: row.usage_estimated === 1,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  }
}

export class DevelopmentLedgerStore {
  private readonly handles = new Map<string, LedgerHandle>()

  constructor(
    private readonly rootDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(rootDir, { recursive: true })
  }

  pathForSeason(seasonId: string): string {
    validateSeasonId(seasonId)
    return join(this.rootDir, `${seasonId}.sqlite`)
  }

  open(seasonId: string): void {
    this.handle(seasonId)
  }

  record(seasonId: string, input: DevelopmentCallInput): number {
    assertValue(input.userId, 'userId')
    assertValue(input.model, 'model')
    assertCount(input.inputTokens, 'inputTokens')
    assertCount(input.reasoningTokens, 'reasoningTokens')
    assertCount(input.outputTokens, 'outputTokens')
    assertCount(input.latencyMs, 'latencyMs')
    const handle = this.handle(seasonId)
    const result = handle.db
      .transaction(() =>
        handle.insertCall.run({
          user_id: input.userId,
          model: input.model,
          request_json: encodeJson(input.request, 'request'),
          completion_json: encodeJson(input.completion, 'completion'),
          input_tokens: input.inputTokens,
          reasoning_tokens: input.reasoningTokens,
          output_tokens: input.outputTokens,
          usage_estimated: input.usageEstimated ? 1 : 0,
          latency_ms: input.latencyMs,
          created_at: input.createdAt ?? this.now().toISOString(),
        }),
      )
      .immediate()
    return Number(result.lastInsertRowid)
  }

  /** Successful committed usage for one participant, grouped by every model name in the ledger. */
  readUserUsageByModel(seasonId: string, userId: string): Record<string, LlmUsage> {
    const rows = this.handle(seasonId).userUsageByModel.all(userId) as Array<
      UsageRow & { model: string }
    >
    return Object.fromEntries(
      rows.map((row) => [
        row.model,
        {
          calls: row.calls,
          inputTokens: row.input_tokens,
          reasoningTokens: row.reasoning_tokens,
          outputTokens: row.output_tokens,
        },
      ]),
    )
  }

  /** Successful rows for one participant, newest first, using a stable reverse-id cursor. */
  listUserCalls(
    seasonId: string,
    userId: string,
    options: { cursor?: number; limit: number },
  ): DevelopmentCallPage {
    assertValue(userId, 'userId')
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new Error('limit must be an integer from 1 to 100')
    }
    if (
      options.cursor !== undefined &&
      (!Number.isSafeInteger(options.cursor) || options.cursor < 1)
    ) {
      throw new Error('cursor must be a positive safe integer')
    }
    const db = this.handle(seasonId).db
    const rows = (
      options.cursor === undefined
        ? db
            .prepare('SELECT * FROM calls WHERE user_id = ? ORDER BY id DESC LIMIT ?')
            .all(userId, options.limit + 1)
        : db
            .prepare('SELECT * FROM calls WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
            .all(userId, options.cursor, options.limit + 1)
    ) as CallRow[]
    const hasMore = rows.length > options.limit
    const calls = rows.slice(0, options.limit).map(decodeCall)
    return {
      calls,
      nextCursor: hasMore ? (calls.at(-1)?.id ?? null) : null,
    }
  }

  /** Successful usage for every participant with at least one row in the season ledger. */
  listParticipantUsage(seasonId: string): DevelopmentParticipantUsage[] {
    const rows = this.handle(seasonId)
      .db.prepare(`SELECT user_id, model,
        COUNT(*) AS calls,
        SUM(usage_estimated) AS estimated_calls,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
        FROM calls GROUP BY user_id, model ORDER BY user_id, model`)
      .all() as ParticipantUsageRow[]
    const participants = new Map<string, DevelopmentParticipantUsage>()
    for (const row of rows) {
      const participant = participants.get(row.user_id) ?? {
        userId: row.user_id,
        usageByModel: {},
        usageEstimated: false,
      }
      participant.usageByModel[row.model] = {
        calls: row.calls,
        inputTokens: row.input_tokens,
        reasoningTokens: row.reasoning_tokens,
        outputTokens: row.output_tokens,
      }
      participant.usageEstimated ||= row.estimated_calls > 0
      participants.set(row.user_id, participant)
    }
    return [...participants.values()]
  }

  hasEstimatedUsage(seasonId: string, userId: string): boolean {
    const row = this.handle(seasonId)
      .db.prepare('SELECT 1 FROM calls WHERE user_id = ? AND usage_estimated = 1 LIMIT 1')
      .get(userId)
    return row !== undefined
  }

  probeHealth(seasonId: string): void {
    writeHealth(this.handle(seasonId).db, this.now().toISOString())
  }

  close(): void {
    const handles = [...this.handles.values()]
    this.handles.clear()
    for (const handle of handles) handle.db.close()
  }

  private handle(seasonId: string): LedgerHandle {
    validateSeasonId(seasonId)
    const cached = this.handles.get(seasonId)
    if (cached !== undefined) return cached
    const db = new BetterSqlite3(this.pathForSeason(seasonId))
    try {
      db.pragma('journal_mode = WAL')
      migrate(db)
      writeHealth(db, this.now().toISOString())
      const handle: LedgerHandle = {
        db,
        insertCall: db.prepare(`INSERT INTO calls (
          user_id, model, request_json, completion_json, input_tokens, reasoning_tokens,
          output_tokens, usage_estimated, latency_ms, created_at
        ) VALUES (
          @user_id, @model, @request_json, @completion_json, @input_tokens, @reasoning_tokens,
          @output_tokens, @usage_estimated, @latency_ms, @created_at
        )`),
        userUsageByModel: db.prepare(`SELECT model,
          COUNT(*) AS calls,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM calls WHERE user_id = ?
          GROUP BY model ORDER BY model`),
      }
      this.handles.set(seasonId, handle)
      return handle
    } catch (error) {
      db.close()
      throw error
    }
  }
}

export const DEVELOPMENT_LEDGER_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION
