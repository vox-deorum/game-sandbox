import { randomUUID } from 'node:crypto'

import type { LogLevel, LogSource } from '@game-sandbox/schema/logs'

/** The level and source vocabulary is shared with the admin route and the frontend client. */
export type { LogLevel, LogSource } from '@game-sandbox/schema/logs'

/** One immutable, process-local log entry. */
export interface LogEntry {
  seq: number
  time: string
  level: LogLevel
  source: LogSource
  message: string
}

export interface LogQuery {
  afterSeq?: number
  level?: LogLevel
  source?: LogSource
  q?: string
}

export interface LogSnapshot {
  bootId: string
  entries: LogEntry[]
  oldestSeq: number | null
  latestSeq: number
  historyTruncated: boolean
  retainedCount: number
  retainedBytes: number
  sources: LogSource[]
}

export interface LogBufferOptions {
  bootId?: string
  clock?: () => Date
  sink?: (message: string) => void
}

/** The retained budget is bytes in the operator API's JSON representation. */
const RETAINED_BYTES_LIMIT = 4 * 1024 * 1024
const MESSAGE_CODE_POINT_LIMIT = 4000

/** A bounded, best-effort process log capture that never affects the work being logged. */
export class LogBuffer {
  readonly bootId: string
  private readonly clock: () => Date
  private readonly sink: (message: string) => void
  private readonly entries: LogEntry[] = []
  private readonly sources = new Set<LogSource>()
  private retainedBytes = 0
  private latestSeq = 0

  constructor(options: LogBufferOptions = {}) {
    this.bootId = options.bootId ?? randomUUID()
    this.clock = options.clock ?? (() => new Date())
    this.sink = options.sink ?? console.error
  }

  /** Write one application event without letting diagnostic work alter the producer's control flow. */
  write(source: LogSource, message: string, level: LogLevel): void {
    try {
      this.sink(message)
    } catch {
      // A diagnostic sink must never interfere with the process it observes.
    }
    try {
      this.capture(source, message, level)
    } catch {
      // Retention is likewise diagnostic only. Preserve the caller's control flow.
    }
  }

  /** Return a detached view of the entries and the capture's current metadata. */
  query(query: LogQuery = {}): LogSnapshot {
    const oldestSeq = this.entries[0]?.seq ?? null
    const needle = query.q?.toLocaleLowerCase()
    const entries = this.entries
      .filter((entry) => {
        if (query.afterSeq !== undefined && entry.seq <= query.afterSeq) return false
        if (query.level !== undefined && entry.level !== query.level) return false
        if (query.source !== undefined && entry.source !== query.source) return false
        return needle === undefined || entry.message.toLocaleLowerCase().includes(needle)
      })
      .map((entry) => ({ ...entry }))
    return {
      bootId: this.bootId,
      entries,
      oldestSeq,
      latestSeq: this.latestSeq,
      historyTruncated:
        query.afterSeq !== undefined && oldestSeq !== null && query.afterSeq < oldestSeq - 1,
      retainedCount: this.entries.length,
      retainedBytes: this.retainedBytes,
      sources: [...this.sources],
    }
  }

  private capture(source: LogSource, message: string, level: LogLevel): void {
    const entry: LogEntry = {
      seq: this.latestSeq + 1,
      time: this.clock().toISOString(),
      level,
      source,
      message: truncateMessage(message),
    }
    const bytes = encodedBytes(entry)
    this.sources.add(source)
    this.latestSeq = entry.seq
    this.entries.push(entry)
    this.retainedBytes += bytes
    while (this.retainedBytes > RETAINED_BYTES_LIMIT && this.entries.length > 0) {
      const evicted = this.entries.shift()
      if (evicted !== undefined) this.retainedBytes -= encodedBytes(evicted)
    }
  }
}

/** Construct the shared log capture. Exported as a factory to keep tests deterministic. */
export function createLogBuffer(options: LogBufferOptions = {}): LogBuffer {
  return new LogBuffer(options)
}

let currentBuffer = createLogBuffer({ sink: () => {} })

/** Install the one process-wide application log capture during startup or a deterministic test. */
export function configureAppLogs(buffer: LogBuffer): void {
  currentBuffer = buffer
}

/** Restore a silent empty capture between isolated tests. */
export function resetAppLogs(): void {
  currentBuffer = createLogBuffer({ sink: () => {} })
}

/** The current process capture, used by the operator route without dependency threading. */
export function appLogBuffer(): LogBuffer {
  return currentBuffer
}

/** Record one application event through the centralized process capture. */
export function appLog(source: LogSource, message: string, level: LogLevel): void {
  currentBuffer.write(source, message, level)
}

function truncateMessage(message: string): string {
  const codePoints = Array.from(message)
  if (codePoints.length <= MESSAGE_CODE_POINT_LIMIT) return message
  return `${codePoints.slice(0, MESSAGE_CODE_POINT_LIMIT - 1).join('')}…`
}

function encodedBytes(entry: LogEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8')
}
