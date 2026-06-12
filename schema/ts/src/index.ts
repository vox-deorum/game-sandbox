/**
 * Typed guards and parsers over the Game Sandbox state schema.
 *
 * Reads need no hand-written casts: each parser narrows through an Ajv validate-function
 * type guard generated from the same canonical schema the Python harness validates
 * against. The generated `types.ts` is the structural shape; Ajv is the runtime check.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import type { RecordingHeader, StepState } from './generated/types.js'

// The shared wire shapes the browser also speaks. These modules are dependency-free (no Node
// built-ins, no Ajv) so the frontend can import them directly through the subpath exports; the
// barrel re-exports them for the Node backend, which already pulls in the Ajv-backed readers below.
export { type EnvironmentMeta, isEnvironmentMeta } from './environment.js'
export type { AgentStep, Message, RecordingHeader, StepState } from './generated/types.js'
export {
  type Command,
  type CommandParse,
  classifyOutbound,
  type OutboundLine,
  parseCommand,
  RESULT_KIND,
  SESSION_KIND,
  serializeCommand,
  sessionEnvelope,
} from './protocol.js'

/** The single integer schema version this reader accepts. */
export const SCHEMA_VERSION = 1

/** Thrown when a payload does not match the schema, or a recording is incoherent. */
export class SchemaValidationError extends Error {}

// The canonical schema lives at the repo's schema/ directory, two levels above src/.
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
function loadSchema(filename: string): object {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, filename), 'utf-8'))
}

// One Ajv instance per process, formats added once, validators compiled once.
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

const validateStepState = ajv.compile<StepState>(loadSchema('step-state.schema.json'))
const validateHeader = ajv.compile<RecordingHeader>(loadSchema('recording-header.schema.json'))

function narrow<T>(validate: ValidateFunction<T>, value: unknown, label: string): T {
  if (validate(value)) {
    return value
  }
  const first = validate.errors?.[0]
  const where = first?.instancePath || '<root>'
  const message = first?.message ?? 'did not match schema'
  throw new SchemaValidationError(`${label} invalid at ${where}: ${message}`)
}

/** Parse and validate one per-step state object, narrowing to {@link StepState}. */
export function parseStepState(value: unknown): StepState {
  return narrow(validateStepState, value, 'step state')
}

/** Parse and validate one recording header, narrowing to {@link RecordingHeader}. */
export function parseHeader(value: unknown): RecordingHeader {
  return narrow(validateHeader, value, 'recording header')
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
