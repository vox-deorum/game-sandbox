/**
 * Parsing for one inbound WebSocket command line from a browser client. `parseCommand` is the trust
 * boundary between untrusted client input and the backend relay and the container it forwards to: it
 * shape-validates a raw line into a {@link Command} or rejects it, and never interprets an action,
 * because the container is authoritative.
 *
 * The module imports zod, so it is Node-only. Its only caller is
 * `backend/src/session/live-session.ts`, reached through the barrel (`schema/ts/src/index.ts`). The
 * browser never parses an inbound command, it only builds and serializes one through the
 * dependency-free `./protocol.js`, which re-exports {@link Command} as a type so it stays free of
 * this module's zod dependency.
 */
import { z } from 'zod'

const InputCommandSchema = z.object({
  kind: z.literal('input'),
  player: z.string(),
  // Opaque on purpose: only the container interprets an action's shape.
  action: z.unknown(),
})

const ChatCommandSchema = z
  .object({
    kind: z.literal('chat'),
    player: z.string(),
    to: z.string().nullable(),
    text: z.string(),
  })
  .strict()

/**
 * Whether a human currently holds the controls for one player. The container spends that player's
 * move budget only while this is true, so the countdown starts when the person can actually act
 * rather than when the loop reached them behind a queue of animating agent turns.
 */
const ClockCommandSchema = z.object({
  kind: z.literal('clock'),
  player: z.string(),
  running: z.boolean(),
})

const PauseCommandSchema = z.object({ kind: z.literal('pause') })
const ResumeCommandSchema = z.object({ kind: z.literal('resume') })
const StopCommandSchema = z.object({ kind: z.literal('stop') })

/**
 * The full command shape, keyed on `kind`. Chat commands are strict because they cross the
 * asynchronous message boundary as one exact protocol shape. Other branches use zod's default
 * object mode, which strips an unrecognized property instead of rejecting the command for carrying
 * one.
 */
const CommandSchema = z.discriminatedUnion('kind', [
  InputCommandSchema,
  ChatCommandSchema,
  ClockCommandSchema,
  PauseCommandSchema,
  ResumeCommandSchema,
  StopCommandSchema,
])

/** A validated inbound command, ready to forward to the container or echo to clients. */
export type Command = z.infer<typeof CommandSchema>

/** The outcome of parsing an inbound command line from a client. */
export type CommandParse = { ok: true; command: Command } | { ok: false; reason: string }

const COMMAND_KINDS = ['input', 'chat', 'clock', 'pause', 'resume', 'stop'] as const

// The fixed wording each field-shape failure gets, keyed by command kind then field name. Kept as an
// explicit table because zod's error reports which field failed but not this codebase's own phrasing
// for it. A missing key fails the same way as a wrong-typed one here: zod v4 treats every shape field
// as required unless it is marked optional, so an absent `action` or `to` already fails validation
// before this table is consulted.
const REASON_BY_FIELD: Record<string, Record<string, string>> = {
  input: {
    player: 'input command needs a string player',
    action: 'input command needs an action',
  },
  chat: {
    player: 'chat command needs a string player',
    to: 'chat command needs a string or null to',
    text: 'chat command needs string text',
  },
  clock: {
    player: 'clock command needs a string player',
    running: 'clock command needs a boolean running',
  },
}

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
  const result = CommandSchema.safeParse(parsed)
  if (!result.success) {
    return { ok: false, reason: describeFailure(parsed, result.error) }
  }
  return { ok: true, command: result.data }
}

/**
 * Recover the hand-written parser's wording for a zod failure. `kind` alone decides between
 * "missing" and "unknown": zod's discriminated union reports a missing, non-string, and
 * unrecognized `kind` as the same "no matching discriminator" issue, so telling them apart means
 * reading the raw value ourselves rather than the zod error.
 */
function describeFailure(parsed: unknown, error: z.ZodError): string {
  const kind =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).kind
      : undefined
  if (typeof kind !== 'string') {
    return 'missing a string kind'
  }
  if (!COMMAND_KINDS.includes(kind as (typeof COMMAND_KINDS)[number])) {
    return `unknown command kind ${kind}`
  }
  const field = error.issues[0]?.path[0]
  const reason = typeof field === 'string' ? REASON_BY_FIELD[kind]?.[field] : undefined
  return reason ?? `${kind} command has an invalid shape`
}
