/**
 * Spread an optional field onto a response object: `{ ...base, ...optionalField('user_name', name) }`
 * adds `user_name` only when `value` is defined, and nothing otherwise. The one place the
 * "present check and the value it guards never drift" rule lives, so the display-name enrichment sites
 * across the routes don't each re-spell `...(value === undefined ? {} : { key: value })`.
 */
export function optionalField<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}
