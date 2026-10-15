import type { RecordingLlmCall } from '../api/client.js'

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

/** The key indexDecisionCalls files a decision's calls under. */
export function decisionCallsKey(tick: number, player: string): string {
  return `${tick}\0${player}`
}

/**
 * Group tick-bound calls by the decision they served, so a log row finds its calls with one lookup
 * instead of scanning every call. Setup calls (a null tick) belong to no decision and are left out.
 */
export function indexDecisionCalls(
  calls: readonly RecordingLlmCall[],
): Map<string, RecordingLlmCall[]> {
  const index = new Map<string, RecordingLlmCall[]>()
  for (const call of calls) {
    if (call.tick === null) continue
    const key = decisionCallsKey(call.tick, call.player)
    const group = index.get(key)
    if (group === undefined) {
      index.set(key, [call])
    } else {
      group.push(call)
    }
  }
  return index
}

/** Setup calls grouped into one row per player, in player order. */
export function groupSetupCalls(
  calls: readonly RecordingLlmCall[],
): { player: string; calls: RecordingLlmCall[] }[] {
  const byPlayer = new Map<string, RecordingLlmCall[]>()
  for (const call of calls) {
    const group = byPlayer.get(call.player) ?? []
    group.push(call)
    byPlayer.set(call.player, group)
  }
  return [...byPlayer.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([player, calls]) => ({ player, calls }))
}
