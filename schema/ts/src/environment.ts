/**
 * The public-facing environment metadata shape and its validation guard.
 *
 * The metadata registry itself lives in Python and is emitted as a generated JSON artifact the
 * backend reads at startup. This module carries only the wire shape both sides share: the field
 * set of one environment's `to_json()`, plus the structural guard that validates it. The backend
 * keeps the `EnvironmentRegistry` and the generated-JSON loading; the browser uses the same guard
 * to validate the `GET /api/environments` response. Keeping the shape here means there is one
 * declaration of it, not a backend copy and a frontend copy that drift.
 *
 * Like {@link ./protocol}, this module is dependency-free so the browser imports it directly.
 */

/** Values that environment parameter declarations can accept on the public wire. */
export type ParameterValue = boolean | number | string | string[]

/** A friendly label for a string-valued choice. */
export interface EnvParameterChoice {
  value: string
  label: string
}

type EnvParameterBase<Type extends EnvParameterType, Default extends ParameterValue> = {
  name: string
  title: string
  description: string
  type: Type
  default: Default
}

/** The parameter kinds the harness publishes in environment metadata. */
export type EnvParameterType = 'int' | 'float' | 'string' | 'bool' | 'choice' | 'multi_choice'

export type EnvParameter =
  | (EnvParameterBase<'int', number> & { min: number; max: number })
  | (EnvParameterBase<'float', number> & { min: number; max: number })
  | EnvParameterBase<'string', string>
  | EnvParameterBase<'bool', boolean>
  | (EnvParameterBase<'choice', string> & { choices: EnvParameterChoice[] })
  | (EnvParameterBase<'multi_choice', string[]> & { choices: EnvParameterChoice[] })

/** The result of validating one value against an environment parameter declaration. */
export type ParameterValidation =
  | { value: ParameterValue; issue?: undefined }
  | { value?: undefined; issue: string }

/** One value problem found while resolving parameter override layers. */
export interface ParameterIssue {
  name: string
  message: string
}

/** The fully defaulted parameter map and any rejected overrides. */
export interface ResolvedParameters {
  values: Record<string, ParameterValue>
  issues: ParameterIssue[]
}

/** The public-facing metadata for one environment, field-for-field the Python `to_json()`. */
export interface EnvironmentMeta {
  env_id: string
  display_name: string
  description: string
  min_slots: number
  max_slots: number
  human_slots: string[]
  human_timeout_ms: number | null
  recommended_episode_ticks: number
  pace_interval_ms: number | null
  step_limit_ms: number
  episode_limit_ms: number
  messaging: boolean
  message_cap: number | null
  llm: boolean
  renderer: string
  /**
   * Whether two agents swapping seats produce a genuinely different game. `true` for a positional
   * game (Hearts), `false` for a symmetric one or a single-slot environment. The multi-seat
   * scheduler reads this to choose ordered (permutation) versus unordered (combination) expansion.
   */
  seat_order_matters: boolean
  /**
   * Optional viewing cadence (ms) for watch/replay playback, independent of `pace_interval_ms` so a
   * turn-based game can slow its playback without becoming realtime. `null` falls back to the
   * frontend's default viewing cadence.
   */
  view_interval_ms: number | null
  /**
   * Optional cadence (ms) at which a live human turn-based session plays out the *other* players'
   * moves, so a burst of fast AI replies animates one at a time instead of snapping together (the
   * human's own move still renders on arrival). `null` — the default and what a realtime env keeps —
   * means "render every frame on arrival". Distinct from `view_interval_ms` (spectator/replay pace).
   */
  live_interval_ms: number | null
  /** The declared gameplay parameters, including the synthesized `seats` declaration. */
  parameters: EnvParameter[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isIntOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isParameterType(value: unknown): value is EnvParameterType {
  return (
    value === 'int' ||
    value === 'float' ||
    value === 'string' ||
    value === 'bool' ||
    value === 'choice' ||
    value === 'multi_choice'
  )
}

/** Structural guard for one friendly parameter choice. */
export function isEnvParameterChoice(value: unknown): value is EnvParameterChoice {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const choice = value as Record<string, unknown>
  return (
    typeof choice.value === 'string' &&
    choice.value.length > 0 &&
    typeof choice.label === 'string' &&
    choice.label.length > 0
  )
}

function isChoiceList(value: unknown): value is EnvParameterChoice[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isEnvParameterChoice)) {
    return false
  }
  return new Set(value.map((choice) => choice.value)).size === value.length
}

/**
 * Validate and normalize a value for one declaration. Multi-choice values are returned in the
 * declaration's option order, so equivalent form selections have one stable representation.
 */
export function validateParameterValue(
  declaration: EnvParameter,
  value: unknown,
): ParameterValidation {
  switch (declaration.type) {
    case 'int':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return { issue: 'must be a JSON-safe integer' }
      }
      if (value < declaration.min || value > declaration.max) {
        return { issue: `must be between ${declaration.min} and ${declaration.max}` }
      }
      return { value }
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { issue: 'must be a finite number' }
      }
      if (value < declaration.min || value > declaration.max) {
        return { issue: `must be between ${declaration.min} and ${declaration.max}` }
      }
      return { value }
    case 'string':
      return typeof value === 'string' ? { value } : { issue: 'must be a string' }
    case 'bool':
      return typeof value === 'boolean' ? { value } : { issue: 'must be a boolean' }
    case 'choice':
      if (
        typeof value !== 'string' ||
        !declaration.choices.some((choice) => choice.value === value)
      ) {
        return { issue: 'must be one of the declared choices' }
      }
      return { value }
    case 'multi_choice': {
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
        return { issue: 'must be an array of declared choice values' }
      }
      if (new Set(value).size !== value.length) {
        return { issue: 'must not contain duplicate choices' }
      }
      const selected = new Set(value)
      if (!value.every((item) => declaration.choices.some((choice) => choice.value === item))) {
        return { issue: 'must contain only declared choices' }
      }
      return {
        value: declaration.choices
          .map((choice) => choice.value)
          .filter((choice) => selected.has(choice)),
      }
    }
  }
}

/** Structural guard for one metadata parameter declaration. */
export function isEnvParameter(value: unknown): value is EnvParameter {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const parameter = value as Record<string, unknown>
  if (
    typeof parameter.name !== 'string' ||
    !/^[a-z][a-z0-9_]*$/.test(parameter.name) ||
    typeof parameter.title !== 'string' ||
    parameter.title.length === 0 ||
    typeof parameter.description !== 'string' ||
    parameter.description.length === 0 ||
    !isParameterType(parameter.type)
  ) {
    return false
  }

  if (parameter.type === 'int' || parameter.type === 'float') {
    const boundsValid =
      typeof parameter.min === 'number' &&
      typeof parameter.max === 'number' &&
      (parameter.type === 'int'
        ? Number.isSafeInteger(parameter.min) && Number.isSafeInteger(parameter.max)
        : Number.isFinite(parameter.min) && Number.isFinite(parameter.max)) &&
      parameter.min <= parameter.max
    if (!boundsValid) {
      return false
    }
  }

  if (
    (parameter.type === 'choice' || parameter.type === 'multi_choice') &&
    !isChoiceList(parameter.choices)
  ) {
    return false
  }

  return validateParameterValue(parameter as EnvParameter, parameter.default).issue === undefined
}

/**
 * Fill defaults from declarations, then validate and apply each override layer in order.
 * Invalid values and unknown names remain out of the resolved map and are reported together.
 */
export function resolveParameters(
  declarations: readonly EnvParameter[],
  ...layers: ReadonlyArray<Readonly<Record<string, unknown>>>
): ResolvedParameters {
  const values: Record<string, ParameterValue> = {}
  const issues: ParameterIssue[] = []
  const declarationsByName = new Map<string, EnvParameter>()

  for (const declaration of declarations) {
    if (declarationsByName.has(declaration.name)) {
      issues.push({ name: declaration.name, message: 'is declared more than once' })
      continue
    }
    declarationsByName.set(declaration.name, declaration)
    const result = validateParameterValue(declaration, declaration.default)
    if (result.issue === undefined) {
      values[declaration.name] = result.value
    } else {
      issues.push({ name: declaration.name, message: `has an invalid default: ${result.issue}` })
    }
  }

  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer)) {
      const declaration = declarationsByName.get(name)
      if (declaration === undefined) {
        issues.push({ name, message: 'is not a declared parameter' })
        continue
      }
      const result = validateParameterValue(declaration, value)
      if (result.issue === undefined) {
        values[name] = result.value
      } else {
        issues.push({ name, message: result.issue })
      }
    }
  }

  return { values, issues }
}

/**
 * Validate and normalize a fully resolved parameter map. Every declaration must have one value,
 * and values for names outside the declarations are rejected.
 *
 * Unlike {@link resolveParameters}, this does not apply defaults. Use it at boundaries that carry
 * a complete map, such as a live-session request or a frozen workflow snapshot. Partial override
 * layers, including season configuration, must continue to use {@link resolveParameters}.
 */
export function validateCompleteParameters(
  declarations: readonly EnvParameter[],
  parameters: Readonly<Record<string, unknown>>,
): ResolvedParameters {
  const values: Record<string, ParameterValue> = {}
  const issues: ParameterIssue[] = []
  const declarationsByName = new Map<string, EnvParameter>()

  for (const declaration of declarations) {
    if (declarationsByName.has(declaration.name)) {
      issues.push({ name: declaration.name, message: 'is declared more than once' })
      continue
    }
    declarationsByName.set(declaration.name, declaration)

    if (!(declaration.name in parameters)) {
      issues.push({ name: declaration.name, message: 'is required' })
      continue
    }
    const result = validateParameterValue(declaration, parameters[declaration.name])
    if (result.issue === undefined) {
      values[declaration.name] = result.value
    } else {
      issues.push({ name: declaration.name, message: result.issue })
    }
  }

  for (const name of Object.keys(parameters)) {
    if (!declarationsByName.has(name)) {
      issues.push({ name, message: 'is not a declared parameter' })
    }
  }

  return { values, issues }
}

/** Structural guard for one metadata entry; the backend loader and the browser client share it. */
export function isEnvironmentMeta(value: unknown): value is EnvironmentMeta {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const m = value as Record<string, unknown>
  const parameters = m.parameters
  if (
    !Array.isArray(parameters) ||
    !parameters.every(isEnvParameter) ||
    new Set(parameters.map((parameter) => parameter.name)).size !== parameters.length
  ) {
    return false
  }
  const seats = parameters[0]
  if (
    seats?.name !== 'seats' ||
    seats.type !== 'int' ||
    seats.default !== m.max_slots ||
    seats.min !== m.min_slots ||
    seats.max !== m.max_slots
  ) {
    return false
  }
  return (
    typeof m.env_id === 'string' &&
    typeof m.display_name === 'string' &&
    typeof m.description === 'string' &&
    typeof m.min_slots === 'number' &&
    typeof m.max_slots === 'number' &&
    isStringArray(m.human_slots) &&
    isIntOrNull(m.human_timeout_ms) &&
    typeof m.recommended_episode_ticks === 'number' &&
    isIntOrNull(m.pace_interval_ms) &&
    typeof m.step_limit_ms === 'number' &&
    typeof m.episode_limit_ms === 'number' &&
    typeof m.messaging === 'boolean' &&
    isIntOrNull(m.message_cap) &&
    typeof m.llm === 'boolean' &&
    typeof m.renderer === 'string' &&
    typeof m.seat_order_matters === 'boolean' &&
    isIntOrNull(m.view_interval_ms) &&
    isIntOrNull(m.live_interval_ms)
  )
}
