/**
 * Environment metadata: the structural shape re-exported from the zod schema, plus the dynamic
 * engine that resolves a runtime-supplied parameter or layout value against it.
 *
 * The metadata registry itself lives in Python; the backend never runs Python, so it reads a
 * generated, committed JSON artifact (`generated/environments.json`, written by
 * `scripts/generate.py` from `discover_environments()` and kept fresh by the
 * `generated-code-fresh` CI job). The HTTP layer serves the list verbatim and the orchestrator
 * reads pace interval, human-capable players, and default timeouts from it.
 *
 * Like {@link ./protocol}, this module is dependency-free so the browser imports it directly: it
 * takes only *types* from `./schemas/environment.js` (a type import erases at build time), never a
 * runtime value, so building it pulls in no zod. The structural guards (`isEnvironmentMeta` and
 * friends) live in that zod module instead, backed by the same schemas this module's types describe.
 */

/** Values that environment parameter declarations can accept on the public wire. */
export type ParameterValue = boolean | number | string | string[]

// -- Structural, defined in zod (./schemas/environment.ts) --------------------------------------
//
// These shapes are validated by the zod schemas generated into `environment-meta.schema.json` and
// checked by `isEnvironmentMeta` and friends there. This module only imports their *types*, so no
// zod code reaches the browser bundle through here.

export type {
  BuiltinAgent,
  EnvironmentLayout,
  EnvironmentMeta,
  EnvParameter,
  EnvParameterChoice,
  EnvParameterType,
  EnvPreset,
  PlayerBoundsLayout,
  SeatDeclaration,
  SeatPlan,
  SeatPlansLayout,
} from './schemas/environment.js'

import type { EnvironmentMeta, EnvParameter, EnvPreset } from './schemas/environment.js'

// -- Dynamic, hand-written here -------------------------------------------------------------------
//
// These validate a runtime value (a submitted override, a resolved parameter map) against a
// runtime-supplied declaration. They accumulate issues, reorder multi-choice values into the
// declaration's canonical order, and derive seat and player ids. They are not structural guards, so
// zod has no equivalent for them, and they stay here rather than moving into the schema module.

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

export interface ResolvedSeat {
  seatId: string
  players: string[]
  restrictedBuiltin: string | null
}

export interface ResolvedLayout {
  planKey: string
  seats: ResolvedSeat[]
  playerCount: number
  seatCount: number
}

/**
 * One seat's score from its members', per [leaderboard.md](../../../docs/specs/leaderboard.md): the
 * arithmetic mean. A mean rather than a sum keeps seats of different widths on one scale, which
 * matters as soon as a game seats a one-player unit beside a three-player one. A singleton seat
 * reports its only member's score unchanged.
 *
 * Shared because three surfaces reduce the same way and must not diverge: the stored workflow result,
 * the replay list's winning seat, and the final-standings card. If they disagreed, a replay could be
 * labelled for a seat the board did not rank first.
 *
 * `memberScores` is the seat's members in declared order and must be nonempty, which every caller
 * gets for free: a resolved layout's seats and a recording header's seat map are both nonempty by
 * construction.
 */
export function reduceSeatScore(memberScores: readonly number[]): number {
  return memberScores.reduce((total, score) => total + score, 0) / memberScores.length
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

/** A compact, user-facing representation for a resolved parameter value. */
export function formatParameterValue(parameter: EnvParameter, value: ParameterValue): string {
  if (parameter.type === 'bool') return value ? 'On' : 'Off'
  if (parameter.type === 'choice') {
    return parameter.choices.find((choice) => choice.value === value)?.label ?? String(value)
  }
  if (parameter.type === 'multi_choice') {
    if (!Array.isArray(value) || value.length === 0) return 'None'
    return value
      .map(
        (selected) =>
          parameter.choices.find((choice) => choice.value === selected)?.label ?? selected,
      )
      .join(', ')
  }
  return String(value)
}

/**
 * Parameters that need a control in player-facing forms. Fixed-value numeric parameters (min equals
 * max, e.g. a synthesized seat count) and single-option choices have no meaningful choice, so
 * surfaces that ask students for settings hide them.
 */
export function visibleParameters(declarations: readonly EnvParameter[]): EnvParameter[] {
  return declarations.filter((parameter) => {
    if (
      (parameter.type === 'int' || parameter.type === 'float') &&
      parameter.min === parameter.max
    ) {
      return false
    }
    return parameter.type !== 'choice' || parameter.choices.length > 1
  })
}

/** The override block one environment preset stands up with during seeding. */
export type PresetOverrides = {
  /** The preset's named parameter values, present when it sets any. */
  parameters?: Record<string, ParameterValue>
  /** Explicit LLM enablement, present only when the preset asks for it. */
  llm?: { enabled: true }
}

/**
 * Convert an environment preset into the season override block its template season starts with:
 * its named parameter values, plus an explicit LLM enablement when the preset asks for it. Undefined
 * when the preset sets neither, so the template season has no override layer at all. Shared by the
 * backend seed and the admin console so "what a preset means" is a single definition.
 */
export function presetOverrides(preset: EnvPreset): PresetOverrides | undefined {
  const overrides: PresetOverrides = {}
  if (Object.keys(preset.values).length > 0) {
    overrides.parameters = { ...preset.values }
  }
  if (preset.llm === true) {
    overrides.llm = { enabled: true }
  }
  return Object.keys(overrides).length === 0 ? undefined : overrides
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

/** Resolve a validated complete parameter map into canonical, ordered seats and players. */
export function resolveLayout(
  meta: EnvironmentMeta,
  parameters: Readonly<Record<string, ParameterValue>>,
): ResolvedLayout {
  if (meta.layout.kind === 'player_bounds') {
    const players = parameters.players
    if (
      typeof players !== 'number' ||
      !Number.isSafeInteger(players) ||
      players < meta.layout.min ||
      players > meta.layout.max
    ) {
      throw new Error('resolved parameters carry no valid players value')
    }
    const seats = Array.from({ length: players }, (_, index) => ({
      seatId: `seat_${index}`,
      players: [`player_${index}`],
      restrictedBuiltin: null,
    }))
    return { planKey: 'solo', seats, playerCount: players, seatCount: players }
  }
  const key = parameters.seat_plan
  if (typeof key !== 'string') throw new Error('resolved parameters carry no valid seat_plan value')
  const plan = meta.layout.plans.find((candidate) => candidate.key === key)
  if (plan === undefined)
    throw new Error(`resolved parameters select unknown seat plan ${JSON.stringify(key)}`)
  const seats = plan.seats.map((declaration, index) => ({
    seatId: `seat_${index}`,
    players: declaration.players.map((player) => `player_${player}`),
    restrictedBuiltin: declaration.restricted_builtin ?? null,
  }))
  return {
    planKey: plan.key,
    seats,
    playerCount: plan.seats.flatMap((declaration) => declaration.players).length,
    seatCount: seats.length,
  }
}
