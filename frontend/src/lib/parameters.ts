import {
  type EnvParameter,
  type ParameterValue,
  validateParameterValue,
} from '@game-sandbox/schema/environment'

/** Parameters that need a control in player-facing forms. */
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

/** Start from a complete prefill map while filling any missing value with its declaration default. */
export function initializeParameters(
  declarations: readonly EnvParameter[],
  values: Readonly<Record<string, ParameterValue>> = {},
): Record<string, ParameterValue> {
  return Object.fromEntries(
    declarations.map((parameter) => {
      const candidate = values[parameter.name] ?? parameter.default
      const result = validateParameterValue(parameter, candidate)
      return [parameter.name, result.issue === undefined ? result.value : parameter.default]
    }),
  )
}

/** Validate and normalize the complete form state, preserving valid values for rendering. */
export function validateParameters(
  declarations: readonly EnvParameter[],
  values: Readonly<Record<string, unknown>>,
): { values: Record<string, ParameterValue>; errors: Record<string, string> } {
  const normalized: Record<string, ParameterValue> = {}
  const errors: Record<string, string> = {}
  for (const parameter of declarations) {
    const result = validateParameterValue(parameter, values[parameter.name])
    if (result.issue === undefined) {
      normalized[parameter.name] = result.value
    } else {
      errors[parameter.name] = result.issue
    }
  }
  return { values: normalized, errors }
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

/** The resolved seat count, with the metadata maximum as a defensive fallback. */
export function resolvedSeatCount(
  declarations: readonly EnvParameter[],
  values: Readonly<Record<string, ParameterValue>>,
  fallback: number,
): number {
  const seats = declarations.find((parameter) => parameter.name === 'seats')
  const value = values.seats
  if (seats?.type === 'int' && typeof value === 'number' && Number.isSafeInteger(value))
    return value
  return fallback
}
