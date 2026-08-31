/**
 * Typed guards and parsers over the Game Sandbox state schema.
 *
 * Reads need no hand-written casts: each parser narrows through the zod schema that is the canonical
 * definition of the contract. `schema/*.schema.json` is generated from those same schemas, and the
 * Python harness validates against the generated copy, so both sides answer to one definition.
 */
import type { z } from 'zod'

import { type RecordingHeader, RecordingHeaderSchema } from './schemas/recording-header.js'
import { type StepState, StepStateSchema } from './schemas/step-state.js'

// parseCommand is Node-only (it imports zod), so it lives in ./command.js rather than the
// dependency-free ./protocol.js the browser imports directly; Command and CommandParse follow it.
export { type Command, type CommandParse, parseCommand } from './command.js'
// The shared wire shapes the browser also speaks. These modules are dependency-free (no Node
// built-ins, no zod) so the frontend can import them directly through the subpath exports; the
// barrel re-exports them for the Node backend, which already pulls in the zod-backed readers below.
export {
  type BuiltinAgent,
  type EnvironmentLayout,
  type EnvironmentMeta,
  type EnvParameter,
  type EnvParameterChoice,
  type EnvParameterType,
  formatParameterValue,
  type ParameterIssue,
  type ParameterValidation,
  type ParameterValue,
  type PlayerBoundsLayout,
  type PresetOverrides,
  presetOverrides,
  type ResolvedLayout,
  type ResolvedParameters,
  type ResolvedSeat,
  resolveLayout,
  resolveParameters,
  type SeatDeclaration,
  type SeatPlan,
  type SeatPlansLayout,
  validateCompleteParameters,
  validateParameterValue,
  visibleParameters,
} from './environment.js'
export type { LlmModelUsage, LlmUsageByModel, ModelAlias } from './llm.js'
export {
  blockedBeforeStart,
  classifyOutbound,
  type OutboundLine,
  RESULT_KIND,
  SESSION_KIND,
  serializeCommand,
  sessionEnvelope,
} from './protocol.js'
// The structural guards are zod-backed, so they live in ./schemas/environment.js rather than the
// dependency-free ./environment.js above; re-exporting a value from there would pull zod into that
// module's graph. The barrel already imports zod for the readers below, so this adds nothing new.
export {
  isBuiltinAgent,
  isEnvironmentMeta,
  isEnvParameter,
  isEnvParameterChoice,
} from './schemas/environment.js'
export type { RecordingHeader } from './schemas/recording-header.js'
export type {
  AgentStep,
  ChatOptions,
  Message,
  StepState,
  StepTiming,
} from './schemas/step-state.js'
export {
  normalizeSeasonDescription,
  RATING_FEEDBACK_MAX,
  RATING_PROMPT_MAX,
  SEASON_DESCRIPTION_MAX,
  type SeasonDescriptionViolation,
  seasonDescriptionViolation,
} from './seasons.js'
// The code-point counter for the messaging cap, shared by the relay pre-gate and the panel counter.
export { codePointLength } from './text.js'
// The schema version lives in a dependency-free module so the browser can import it without zod.
export { SCHEMA_VERSION } from './version.js'

/** Thrown when a payload does not match the schema, or a recording is incoherent. */
export class SchemaValidationError extends Error {}

/**
 * Narrow a value through a schema, reporting the first issue in the same shape the readers have
 * always used: the JSON-pointer-style location of the offending value, then what was wrong with it.
 */
function narrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (result.success) {
    return result.data
  }
  const first = result.error.issues[0]
  const where =
    first === undefined || first.path.length === 0 ? '<root>' : `/${first.path.join('/')}`
  const message = first?.message ?? 'did not match schema'
  throw new SchemaValidationError(`${label} invalid at ${where}: ${message}`)
}

/** Parse and validate one per-step state object, narrowing to {@link StepState}. */
export function parseStepState(value: unknown): StepState {
  return narrow(StepStateSchema, value, 'step state')
}

/** Parse and validate one recording header, narrowing to {@link RecordingHeader}. */
export function parseHeader(value: unknown): RecordingHeader {
  const header = narrow(RecordingHeaderSchema, value, 'recording header')
  const attributedPlayers = Object.keys(header.players)
  const seatedPlayers = Object.values(header.seats).flat()
  if (
    seatedPlayers.length !== attributedPlayers.length ||
    new Set(seatedPlayers).size !== seatedPlayers.length ||
    seatedPlayers.some((player) => !Object.hasOwn(header.players, player)) ||
    attributedPlayers.some((player) => !seatedPlayers.includes(player))
  ) {
    throw new SchemaValidationError(
      'recording header seats must partition attributed players exactly',
    )
  }
  return header
}

export interface ParsedRecording {
  header: RecordingHeader
  states: StepState[]
}

/**
 * Read a JSONL recording: the header line, then one per-step state per line.
 *
 * Enforces that every line's `schema_version` matches the header's. Unknown sidecars
 * declared in the header are tolerated and ignored per the documented rule. A blank or
 * truncated trailing line ends the readable prefix rather than failing the read.
 */
export function readRecording(input: string | readonly string[]): ParsedRecording {
  const rawLines = typeof input === 'string' ? input.split('\n') : input
  const lines = rawLines.map((line) => line.trim()).filter((line) => line.length > 0)
  const headerLine = lines[0]
  if (headerLine === undefined) {
    throw new SchemaValidationError('recording is empty')
  }

  const stateLines = lines.slice(1)
  const header = parseHeader(JSON.parse(headerLine))

  const states: StepState[] = []
  for (const line of stateLines) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      // A crashed session can leave a half-written final line; stop at the prefix.
      break
    }
    const state = parseStepState(value)
    if (state.schema_version !== header.schema_version) {
      throw new SchemaValidationError(
        `state line schema_version ${state.schema_version} does not match header version ${header.schema_version}`,
      )
    }
    states.push(state)
  }
  return { header, states }
}
