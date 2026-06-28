/**
 * Shared form-input parsing helpers. Pure functions only, no reactivity — the counterpart to
 * format.ts (which renders values out), this reads user-entered field values back in.
 */

/**
 * A numeric field's value as "a finite number or no value". Vue casts a `type="number"` input to a
 * number (and leaves a blank field the empty string), so this accepts `string | number`: a blank or
 * non-finite value becomes `undefined` (the field was left at its default), anything else a number.
 * The seed and timeout fields on the start forms parse through this.
 */
export function optionalNumber(raw: string | number): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined
  }
  if (raw.trim() === '') {
    return undefined
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}
