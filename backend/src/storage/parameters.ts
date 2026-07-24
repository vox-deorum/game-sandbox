/** JSON codecs for normalized environment parameter maps stored in SQLite text columns. */
import type { ParameterValue } from '@game-sandbox/schema/environment'

function isParameterValue(value: unknown): value is ParameterValue {
  if (typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Check that a value really is a storable parameter map. Both codecs share it, so an encode and a
 * decode of the same map can never disagree about what storage accepts.
 */
function assertParameterMap(value: unknown): asserts value is Record<string, ParameterValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('parameter map must be a JSON object')
  }
  for (const [name, parameter] of Object.entries(value)) {
    if (!isParameterValue(parameter)) {
      throw new Error(`parameter map value ${name} is not a JSON-safe parameter value`)
    }
  }
}

export function parseParameterMap(text: string): Record<string, ParameterValue> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `parameter map is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  assertParameterMap(value)
  return value
}

export function encodeParameterMap(values: Record<string, ParameterValue>): string {
  // Checked before serializing rather than after, so a value `JSON.stringify` would quietly drop
  // (an explicit `undefined`) is rejected instead of vanishing from the stored map.
  assertParameterMap(values)
  return JSON.stringify(values)
}
