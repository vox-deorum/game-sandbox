/**
 * The wire protocol shared by the container channel, the backend relay, and the browser WebSocket.
 *
 * One classification rule spans both directions: a line is an **event envelope** when its top-level
 * JSON object carries a `kind`, and a **recording line** (the header or a per-step state) otherwise.
 * The rule holds because the state schema defines no top-level `kind` — the schema-guard test asserts
 * that against the packaged schema so it cannot rot. Recording lines are relayed verbatim in both
 * directions; envelopes are interpreted.
 *
 * Outbound (container → backend → browser) this stage defines one envelope kind, `result`, plus the
 * backend-originated `session` status frame and the relayed `pause`/`resume` echoes. Inbound
 * (browser → backend → container) the command envelopes are `input` (with a player and action),
 * `clock` (whether a human holds the controls for a player, so the container spends that player's
 * move budget only while they can act), `pause`, `resume`, `stop`, and `chat` (a human message: a
 * player, a recipient `to` or null for a broadcast, and plain text). This module defines the
 * `Command` shape and how the browser serializes one; parsing and shape-validating an untrusted
 * inbound line is `./command.js`'s job, since that needs zod and this module must not.
 *
 * This module is dependency-free on purpose: the browser imports it directly (no Node built-ins, no
 * zod) so the line-classification rule and the `Command` type live in one dependency-free place for
 * both sides of the socket.
 */
import type { Command } from './command.js'

/**
 * A validated inbound command, ready to forward to the container or echo to clients. Defined in
 * `./command.js`, which owns parsing one; re-exported here as a type only, which erases at build
 * time, so this module stays dependency-free.
 */
export type { Command }

/** The single outbound event-envelope kind the container emits, once, at session end. */
export const RESULT_KIND = 'result'
/** The backend-originated status frame sent to browsers on attach and at end. */
export const SESSION_KIND = 'session'

/**
 * The result of classifying one outbound line from the container. The `recording` variant carries
 * the parsed object alongside the raw text so a consumer (the relay's per-audience message filter)
 * can inspect fields like `messages` without parsing the line a second time.
 */
export type OutboundLine =
  | { type: 'recording'; raw: string; value: Record<string, unknown> }
  | { type: 'envelope'; kind: string; raw: string; value: Record<string, unknown> }
  | { type: 'malformed'; raw: string }

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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
  return { type: 'recording', raw, value: object }
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
