import { LOG_LEVELS, LOG_SOURCES } from '@game-sandbox/schema/logs'
import type { FastifyInstance } from 'fastify'

import type { LogBuffer, LogLevel, LogSource } from '../logging/log-buffer.js'

/** Register the bounded, process-local log view in the already administrator-gated plugin. */
export function registerAdminLogRoutes(admin: FastifyInstance, logs: LogBuffer): void {
  admin.get<{ Querystring: Record<string, string | string[] | undefined> }>(
    '/logs',
    {
      onSend: (_request, reply, payload, done) => {
        reply.header('cache-control', 'no-store')
        done(null, payload)
      },
    },
    (request, reply) => {
      const parsed = parseLogQuery(request.query)
      if ('error' in parsed) return reply.code(400).send({ error: parsed.error })
      const snapshot = logs.query(parsed)
      return reply.send({
        boot_id: snapshot.bootId,
        entries: snapshot.entries,
        oldest_seq: snapshot.oldestSeq,
        latest_seq: snapshot.latestSeq,
        history_truncated: snapshot.historyTruncated,
        retained_count: snapshot.retainedCount,
        retained_bytes: snapshot.retainedBytes,
        sources: snapshot.sources,
      })
    },
  )
}

function parseLogQuery(
  query: Record<string, string | string[] | undefined>,
): { afterSeq?: number; level?: LogLevel; source?: LogSource; q?: string } | { error: string } {
  const allowed = new Set(['after_seq', 'level', 'source', 'q'])
  if (Object.keys(query).some((key) => !allowed.has(key))) return { error: 'invalid log query' }
  const afterSeq = scalar(query.after_seq)
  const level = scalar(query.level)
  const source = scalar(query.source)
  const q = scalar(query.q)
  if (afterSeq === null || level === null || source === null || q === null) {
    return { error: 'invalid log query' }
  }
  if (
    afterSeq !== undefined &&
    (!/^\d+$/.test(afterSeq) || !Number.isSafeInteger(Number(afterSeq)))
  ) {
    return { error: 'invalid log query' }
  }
  if (level !== undefined && !LOG_LEVELS.includes(level as LogLevel))
    return { error: 'invalid log query' }
  if (source !== undefined && !LOG_SOURCES.includes(source as LogSource)) {
    return { error: 'invalid log query' }
  }
  const trimmed = q?.trim()
  if (trimmed !== undefined && trimmed.length > 200) return { error: 'invalid log query' }
  return {
    ...(afterSeq === undefined ? {} : { afterSeq: Number(afterSeq) }),
    ...(level === undefined ? {} : { level: level as LogLevel }),
    ...(source === undefined ? {} : { source: source as LogSource }),
    ...(trimmed === undefined || trimmed === '' ? {} : { q: trimmed }),
  }
}

function scalar(value: string | string[] | undefined): string | undefined | null {
  return Array.isArray(value) ? null : value
}
