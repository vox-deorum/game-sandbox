import {
  type EnvParameter,
  formatParameterValue,
  type ParameterValue,
  resolveParameters,
  validateCompleteParameters,
  visibleParameters,
} from '@game-sandbox/schema/environment'

/**
 * Start from a complete prefill map, filling any missing or rejected value with its declaration
 * default. This is the shared resolver's own defaulting behavior, so a form cannot disagree with the
 * server about what a partial or drifted layer resolves to.
 */
export function initializeParameters(
  declarations: readonly EnvParameter[],
  values: Readonly<Record<string, ParameterValue>> = {},
): Record<string, ParameterValue> {
  return resolveParameters(declarations, values).values
}

/**
 * Validate and normalize the complete form state, keeping the valid values and reporting one message
 * per rejected field. A thin adapter over the shared complete-map validator, so the rules a form
 * enforces are literally the rules the server enforces.
 */
export function validateParameters(
  declarations: readonly EnvParameter[],
  values: Readonly<Record<string, unknown>>,
): { values: Record<string, ParameterValue>; errors: Record<string, string> } {
  const result = validateCompleteParameters(declarations, values)
  const errors: Record<string, string> = {}
  for (const issue of result.issues) {
    errors[issue.name] = issue.message
  }
  return { values: result.values, errors }
}

/**
 * The player-facing settings a resolved parameter map represents: one title/value pair per visible
 * declaration, in declaration order, with a missing entry falling back to its default. Everything that
 * shows an episode's or a season's settings reads from here, so a season summary and a replay's own
 * settings name and format the same values the same way.
 */
export function describeParameters(
  declarations: readonly EnvParameter[],
  values: Readonly<Record<string, ParameterValue>>,
): { label: string; value: string }[] {
  return visibleParameters(declarations).map((parameter) => ({
    label: parameter.title,
    value: formatParameterValue(parameter, values[parameter.name] ?? parameter.default),
  }))
}
