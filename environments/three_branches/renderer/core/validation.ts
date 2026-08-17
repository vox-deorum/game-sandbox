/** Read an array from a renderer-owned JSON document. */
export function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`)
  return value
}

/** Read a finite number from a renderer-owned JSON document. */
export function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite.`)
  }
  return value
}

/** Read a finite number greater than zero. */
export function positiveNumber(value: unknown, name: string): number {
  const result = finiteNumber(value, name)
  if (result <= 0) throw new Error(`${name} must be positive.`)
  return result
}

/** Read an integer greater than zero. */
export function positiveInteger(value: unknown, name: string): number {
  const result = finiteNumber(value, name)
  if (!Number.isInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return result
}

/** Read an integer greater than or equal to zero. */
export function nonnegativeInteger(value: unknown, name: string): number {
  const result = finiteNumber(value, name)
  if (!Number.isInteger(result) || result < 0) {
    throw new Error(`${name} must be a non-negative integer.`)
  }
  return result
}
