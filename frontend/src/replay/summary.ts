import type { StepState } from '@game-sandbox/schema'

import { formatPlayer } from '../lib/format.js'
import { latestPlayerScores, type PlayerScoreMap, type RunSummary } from '../lib/state.js'

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value)
  }
  return value.toFixed(2).replace(/\.?0+$/, '')
}

export function formatScoreMap(scores: Readonly<PlayerScoreMap>): string | null {
  // Callers provide an already-sanitized finite PlayerScoreMap.
  const entries = Object.entries(scores).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) {
    return null
  }
  if (entries.length === 1) {
    const first = entries[0]
    return first === undefined ? null : formatNumber(first[1])
  }
  return entries
    .map(([playerId, score]) => `${formatPlayer(playerId)}: ${formatNumber(score)}`)
    .join(', ')
}

export function summarizeStates(states: readonly StepState[]): RunSummary {
  const scores = latestPlayerScores(states)
  return {
    score: formatScoreMap(scores),
    ticks: states.length > 0 ? states.length : null,
    scores,
  }
}
