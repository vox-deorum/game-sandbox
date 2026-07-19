/**
 * Successful LLM-call telemetry stored outside the application database, one SQLite file per
 * execution scope. A live session uses its session id as the scope; every game in a workflow run
 * shares the run id. The store is synchronous because admission needs committed usage before it can
 * reserve a request, and better-sqlite3 serializes each file's writes in process.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import BetterSqlite3 from 'better-sqlite3'

import type { LlmUsage } from '../../llm/types.js'
import { totalTokens } from '../../llm/types.js'

const CURRENT_SCHEMA_VERSION = 2
const SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface ExecutionTelemetryCallInput {
  sessionId: string
  slot: string
  tick: number | null
  model: string
  costWeight: number
  budgetCostUnits: number
  request: unknown
  completion: unknown
  inputTokens: number
  reasoningTokens: number
  outputTokens: number
  usageEstimated: boolean
  latencyMs: number
  createdAt?: string
}

export interface ExecutionTelemetryCall extends Required<ExecutionTelemetryCallInput> {
  id: number
}

export interface TelemetryCallFilter {
  sessionId?: string
  slot?: string
  model?: string
}

export interface ExecutionModelUsage extends LlmUsage {
  estimatedCalls: number
  latencyMs: number
}

export type ExecutionUsageByModel = Record<string, ExecutionModelUsage>

interface CallRow {
  id: number
  session_id: string
  slot: string
  tick: number | null
  model: string
  cost_weight: number | null
  budget_cost_units: number | null
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

interface ModelUsageRow extends UsageRow {
  model: string
  estimated_calls: number
  latency_ms: number
}

interface ScopeHandle {
  db: BetterSqlite3.Database
  insertCall: BetterSqlite3.Statement
  sessionUsageByModel: BetterSqlite3.Statement
}

function validateScopeId(scopeId: string): void {
  if (!SCOPE_ID.test(scopeId)) {
    throw new Error(
      'LLM telemetry scope id must be 1-128 filename-safe ASCII letters, digits, underscores, or hyphens',
    )
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`${name} must not be empty`)
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`)
  }
}

function encodeJson(value: unknown, name: string): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new Error(`${name} must be JSON-serializable`)
  }
  return encoded
}

function decodeUsage(row: UsageRow): LlmUsage {
  return {
    calls: row.calls,
    inputTokens: row.input_tokens,
    reasoningTokens: row.reasoning_tokens,
    outputTokens: row.output_tokens,
  }
}

function decodeCall(row: CallRow): ExecutionTelemetryCall {
  if (row.cost_weight === null || row.budget_cost_units === null) {
    throw new Error('LLM telemetry row has no authoritative cost basis')
  }
  validateCostBasis(row.cost_weight, row.budget_cost_units, row.input_tokens, row.output_tokens)
  return {
    id: row.id,
    sessionId: row.session_id,
    slot: row.slot,
    tick: row.tick,
    model: row.model,
    costWeight: row.cost_weight,
    budgetCostUnits: row.budget_cost_units,
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

function validateCostBasis(
  costWeight: number,
  budgetCostUnits: number,
  inputTokens: number,
  outputTokens: number,
): void {
  assertPositiveFinite(costWeight, 'costWeight')
  assertNonNegativeFinite(budgetCostUnits, 'budgetCostUnits')
  const expected = costWeight * totalTokens({ inputTokens, outputTokens })
  if (!Number.isFinite(expected) || budgetCostUnits !== expected) {
    throw new Error('budgetCostUnits must exactly match costWeight times input and output tokens')
  }
}

function migrate(db: BetterSqlite3.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `LLM telemetry schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
    )
  }

  if (version < 1) {
    const hasCalls =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calls'").get() !==
      undefined
    if (!hasCalls) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE calls (
            id                INTEGER PRIMARY KEY,
            session_id        TEXT NOT NULL,
            slot              TEXT NOT NULL,
            tick              INTEGER,
            model             TEXT NOT NULL,
            cost_weight       REAL NOT NULL,
            budget_cost_units REAL NOT NULL,
            request_json      TEXT NOT NULL,
            completion_json   TEXT NOT NULL,
            input_tokens      INTEGER NOT NULL,
            reasoning_tokens  INTEGER NOT NULL,
            output_tokens     INTEGER NOT NULL,
            usage_estimated   INTEGER NOT NULL,
            latency_ms        INTEGER NOT NULL,
            created_at        TEXT NOT NULL
          );
          CREATE INDEX calls_session_slot ON calls (session_id, slot);
          CREATE INDEX calls_created_at ON calls (created_at);
          CREATE TABLE meter_health (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            checked_at TEXT NOT NULL
          );
        `)
        db.pragma('user_version = 2')
      }).immediate()
      return
    }
    db.transaction(() => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS calls_session_slot ON calls (session_id, slot);
        CREATE INDEX IF NOT EXISTS calls_created_at ON calls (created_at);
        CREATE TABLE IF NOT EXISTS meter_health (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          checked_at TEXT NOT NULL
        );
      `)
      db.pragma('user_version = 1')
    }).immediate()
  }
  if (version < 2) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE calls ADD COLUMN cost_weight REAL;
        ALTER TABLE calls ADD COLUMN budget_cost_units REAL;
      `)
      db.pragma('user_version = 2')
    }).immediate()
  }
}

/** A retained official telemetry file cannot be surfaced authoritatively. */
export class TelemetryUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TelemetryUnavailableError'
  }
}

function writeHealth(db: BetterSqlite3.Database, checkedAt: string): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO meter_health (id, checked_at) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET checked_at = excluded.checked_at`,
    ).run(checkedAt)
    const row = db.prepare('SELECT checked_at FROM meter_health WHERE id = 1').get() as
      | { checked_at: string }
      | undefined
    if (row?.checked_at !== checkedAt) {
      throw new Error('LLM telemetry write-health readback did not match')
    }
  }).immediate()
}

/** Owns cached handles for all official execution-scope telemetry files under one root directory. */
export class ExecutionTelemetryStore {
  private readonly handles = new Map<string, ScopeHandle>()

  constructor(
    private readonly rootDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(rootDir, { recursive: true })
  }

  /** The validated on-disk location, exposed for lifecycle integration and diagnostics. */
  pathForScope(scopeId: string): string {
    validateScopeId(scopeId)
    return join(this.rootDir, `${scopeId}.sqlite`)
  }

  /** Open, migrate, and write-probe a scope before returning it to admission or query code. */
  open(scopeId: string): void {
    this.handle(scopeId)
  }

  /** Commit one successful logical request in a transaction and return its durable row id. */
  insert(scopeId: string, input: ExecutionTelemetryCallInput): number {
    assertNonEmpty(input.sessionId, 'sessionId')
    assertNonEmpty(input.slot, 'slot')
    assertNonEmpty(input.model, 'model')
    if (input.tick !== null) {
      assertNonNegativeInteger(input.tick, 'tick')
    }
    assertNonNegativeInteger(input.inputTokens, 'inputTokens')
    assertNonNegativeInteger(input.reasoningTokens, 'reasoningTokens')
    assertNonNegativeInteger(input.outputTokens, 'outputTokens')
    assertNonNegativeInteger(input.latencyMs, 'latencyMs')
    validateCostBasis(
      input.costWeight,
      input.budgetCostUnits,
      input.inputTokens,
      input.outputTokens,
    )

    const handle = this.handle(scopeId)
    const values = {
      session_id: input.sessionId,
      slot: input.slot,
      tick: input.tick,
      model: input.model,
      cost_weight: input.costWeight,
      budget_cost_units: input.budgetCostUnits,
      request_json: encodeJson(input.request, 'request'),
      completion_json: encodeJson(input.completion, 'completion'),
      input_tokens: input.inputTokens,
      reasoning_tokens: input.reasoningTokens,
      output_tokens: input.outputTokens,
      usage_estimated: input.usageEstimated ? 1 : 0,
      latency_ms: input.latencyMs,
      created_at: input.createdAt ?? this.now().toISOString(),
    }
    const result = handle.db.transaction(() => handle.insertCall.run(values)).immediate()
    return Number(result.lastInsertRowid)
  }

  /** Record-sink spelling used by the shared proxy handler. */
  record(scopeId: string, input: ExecutionTelemetryCallInput): number {
    return this.insert(scopeId, input)
  }

  /** Successful committed usage for one slot, grouped by every model name present in telemetry. */
  readSessionUsageByModel(
    scopeId: string,
    sessionId: string,
    slot: string,
  ): Record<string, LlmUsage> {
    const rows = this.handle(scopeId).sessionUsageByModel.all(sessionId, slot) as Array<
      UsageRow & { model: string }
    >
    return Object.fromEntries(rows.map((row) => [row.model, decodeUsage(row)]))
  }

  /** List successful rows in insertion order, optionally narrowed by stable telemetry fields. */
  listCalls(scopeId: string, filter: TelemetryCallFilter = {}): ExecutionTelemetryCall[] {
    const { sql, values } = filteredQuery('SELECT * FROM calls', filter)
    const rows = this.handle(scopeId)
      .db.prepare(`${sql} ORDER BY id`)
      .all(...values) as CallRow[]
    return rows.map(decodeCall)
  }

  /**
   * Read one retained recording association without creating, migrating, probing, or caching its
   * scope file. Legacy and incomplete files fail because their historical price cannot be rebuilt
   * from mutable configuration.
   */
  readAssociatedCalls(scopeId: string, sessionId: string): ExecutionTelemetryCall[] {
    const path = this.pathForScope(scopeId)
    if (!existsSync(path)) {
      throw new TelemetryUnavailableError('Associated LLM telemetry file is missing')
    }
    let db: BetterSqlite3.Database | undefined
    try {
      db = new BetterSqlite3(path, { readonly: true, fileMustExist: true })
      const version = db.pragma('user_version', { simple: true }) as number
      if (version !== CURRENT_SCHEMA_VERSION) {
        throw new Error(`unsupported LLM telemetry schema version ${version}`)
      }
      const rows = db
        .prepare('SELECT * FROM calls WHERE session_id = ? ORDER BY id')
        .all(sessionId) as CallRow[]
      return rows.map(decodeCall)
    } catch (error) {
      if (error instanceof TelemetryUnavailableError) throw error
      throw new TelemetryUnavailableError('Associated LLM telemetry is unavailable', {
        cause: error,
      })
    } finally {
      db?.close()
    }
  }

  /** Exact successful-call sums grouped by the public model alias. */
  aggregateByModel(scopeId: string, filter: TelemetryCallFilter = {}): ExecutionUsageByModel {
    const { sql, values } = filteredQuery(
      `SELECT model,
              COUNT(*) AS calls,
              SUM(usage_estimated) AS estimated_calls,
              SUM(input_tokens) AS input_tokens,
              SUM(reasoning_tokens) AS reasoning_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(latency_ms) AS latency_ms
       FROM calls`,
      filter,
    )
    const rows = this.handle(scopeId)
      .db.prepare(`${sql} GROUP BY model ORDER BY model`)
      .all(...values) as ModelUsageRow[]
    return Object.fromEntries(
      rows.map((row) => [
        row.model,
        {
          calls: row.calls,
          estimatedCalls: row.estimated_calls,
          inputTokens: row.input_tokens,
          reasoningTokens: row.reasoning_tokens,
          outputTokens: row.output_tokens,
          latencyMs: row.latency_ms,
        },
      ]),
    )
  }

  /** Verify that the scope can still commit and read back a write transaction. */
  probeHealth(scopeId: string): void {
    writeHealth(this.handle(scopeId).db, this.now().toISOString())
  }

  /** Close a cached handle. A later operation safely reopens and probes the same file. */
  closeScope(scopeId: string): void {
    validateScopeId(scopeId)
    const handle = this.handles.get(scopeId)
    if (handle === undefined) {
      return
    }
    this.handles.delete(scopeId)
    handle.db.close()
  }

  /** Close before unlinking, which is required for reliable deletion on Windows. */
  deleteScope(scopeId: string): void {
    const path = this.pathForScope(scopeId)
    this.closeScope(scopeId)
    rmSync(path, { force: true })
    rmSync(`${path}-shm`, { force: true })
    rmSync(`${path}-wal`, { force: true })
  }

  /**
   * Delete top-level official scope databases outside the supplied durable recording keep set.
   * Directories, including the development-ledger subtree, are never descended into.
   */
  deleteOrphanedScopes(referencedScopeIds: ReadonlySet<string>): string[] {
    const deleted: string[] = []
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue
      const scopeId = entry.name.slice(0, -'.sqlite'.length)
      if (!SCOPE_ID.test(scopeId) || referencedScopeIds.has(scopeId)) continue
      this.deleteScope(scopeId)
      deleted.push(scopeId)
    }
    return deleted.sort()
  }

  /** Release every cached SQLite handle. Idempotent. */
  close(): void {
    const handles = [...this.handles.values()]
    this.handles.clear()
    for (const handle of handles) {
      handle.db.close()
    }
  }

  private handle(scopeId: string): ScopeHandle {
    validateScopeId(scopeId)
    const cached = this.handles.get(scopeId)
    if (cached !== undefined) {
      return cached
    }

    const db = new BetterSqlite3(this.pathForScope(scopeId))
    try {
      db.pragma('journal_mode = WAL')
      migrate(db)
      writeHealth(db, this.now().toISOString())
      const handle: ScopeHandle = {
        db,
        insertCall: db.prepare(`
          INSERT INTO calls (
            session_id, slot, tick, model, cost_weight, budget_cost_units,
            request_json, completion_json,
            input_tokens, reasoning_tokens, output_tokens, usage_estimated, latency_ms, created_at
          ) VALUES (
            @session_id, @slot, @tick, @model, @cost_weight, @budget_cost_units,
            @request_json, @completion_json,
            @input_tokens, @reasoning_tokens, @output_tokens, @usage_estimated, @latency_ms, @created_at
          )
        `),
        sessionUsageByModel: db.prepare(`
          SELECT model,
                 COUNT(*) AS calls,
                 COALESCE(SUM(input_tokens), 0) AS input_tokens,
                 COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
                 COALESCE(SUM(output_tokens), 0) AS output_tokens
          FROM calls WHERE session_id = ? AND slot = ?
          GROUP BY model ORDER BY model
        `),
      }
      this.handles.set(scopeId, handle)
      return handle
    } catch (error) {
      db.close()
      throw error
    }
  }
}

function filteredQuery(
  base: string,
  filter: TelemetryCallFilter,
): { sql: string; values: string[] } {
  const clauses: string[] = []
  const values: string[] = []
  for (const [column, value] of [
    ['session_id', filter.sessionId],
    ['slot', filter.slot],
    ['model', filter.model],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${column} = ?`)
      values.push(value)
    }
  }
  return { sql: clauses.length === 0 ? base : `${base} WHERE ${clauses.join(' AND ')}`, values }
}

export const EXECUTION_TELEMETRY_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION
