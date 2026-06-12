/**
 * The wire protocol shared by the container channel and the browser WebSocket.
 *
 * One classification rule spans both directions: a line is an **event envelope** when its top-level
 * JSON object carries a `kind`, and a **recording line** (the header or a per-step state) otherwise.
 * The rule holds because the state schema defines no top-level `kind` — a backend test asserts that
 * against the packaged schema so it cannot rot. Recording lines are relayed verbatim in both
 * directions; envelopes are interpreted.
 *
 * Outbound (container → backend → browser) this stage defines one envelope kind, `result`, plus the
 * backend-originated `session` status frame and the relayed `pause`/`resume` echoes. Inbound
 * (browser → backend → container) the command envelopes are `input` (with a slot and action),
 * `pause`, `resume`, and `stop`; Stage 9 adds `chat` on the same shape. The backend validates a
 * command's shape and the sender's authority, then forwards it — it never interprets an action,
 * because the container is authoritative.
 */

/** The single outbound event-envelope kind the container emits, once, at session end. */
export const RESULT_KIND = 'result'
/** The backend-originated status frame sent to browsers on attach and at end. */
export const SESSION_KIND = 'session'

/** A validated inbound command, ready to forward to the container or echo to clients. */
export type Command =
  | { kind: 'input'; slot: string; action: unknown }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }

/** The result of classifying one outbound line from the container. */
export type OutboundLine =
  | { type: 'recording'; raw: string }
  | { type: 'envelope'; kind: string; raw: string; value: Record<string, unknown> }
  | { type: 'malformed'; raw: string }

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(object, key)
}

/**
 * Classify one outbound line: a recording line (no top-level `kind`), an event envelope (a string
 * `kind`), or malformed (not a JSON object). Malformed lines are logged and dropped by the relay —
 * the backend must never propagate garbage as if it were a state.
 */
export function classifyOutbound(raw: string): OutboundLine {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { type: 'malformed', raw }
  }
  const object = asObject(parsed)
  if (object === null) {
    return { type: 'malformed', raw }
  }
  if (typeof object.kind === 'string') {
    return { type: 'envelope', kind: object.kind, raw, value: object }
  }
  return { type: 'recording', raw }
}

/** The outcome of parsing an inbound command line from a client. */
export type CommandParse = { ok: true; command: Command } | { ok: false; reason: string }

/**
 * Parse and shape-validate one inbound command line. Unknown kinds and malformed lines are
 * rejected (the caller logs and ignores them); the action of an `input` is passed through opaque,
 * because only the container interprets it.
 */
export function parseCommand(raw: string): CommandParse {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'not valid JSON' }
  }
  const object = asObject(parsed)
  if (object === null || typeof object.kind !== 'string') {
    return { ok: false, reason: 'missing a string kind' }
  }
  switch (object.kind) {
    case 'input': {
      if (typeof object.slot !== 'string') {
        return { ok: false, reason: 'input command needs a string slot' }
      }
      if (!hasOwn(object, 'action')) {
        return { ok: false, reason: 'input command needs an action' }
      }
      return { ok: true, command: { kind: 'input', slot: object.slot, action: object.action } }
    }
    case 'pause':
    case 'resume':
    case 'stop':
      return { ok: true, command: { kind: object.kind } }
    default:
      return { ok: false, reason: `unknown command kind ${object.kind}` }
  }
}

/** Serialize a validated command to the canonical line the container parses. */
export function serializeCommand(command: Command): string {
  return JSON.stringify(command)
}

/** Build the backend-originated `session` status frame. */
export function sessionEnvelope(status: 'running' | 'ended', reason?: string): string {
  return JSON.stringify(
    reason ? { kind: SESSION_KIND, status, reason } : { kind: SESSION_KIND, status },
  )
}
