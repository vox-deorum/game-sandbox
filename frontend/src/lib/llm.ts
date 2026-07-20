/** Format authoritative weighted cost compactly and always name its budget unit. */
export function formatLlmCost(units: number): string {
  const value = Number.isFinite(units) ? Math.max(0, units) : 0
  const formatted = new Intl.NumberFormat('en-US', {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 10_000 ? 1 : 2,
  })
    .format(value)
    .replace(/([KMBT])$/, (suffix) => suffix.toLowerCase())
  return `${formatted} units`
}
