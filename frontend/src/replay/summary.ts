import type { StepState } from '@game-sandbox/schema'

import { formatSlot } from '../lib/format.js'

// Recordings do not store the trailing result envelope, so replay and terminal-session pages derive
// their final score and tick count from the readable state prefix instead.
export interface RunSummary {
  score: string | null
  ticks: number | null
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value)
  }
  return value.toFixed(2).replace(/\.?0+$/, '')
}

export function formatScoreMap(scores: Record<string, unknown>): string | null {
  const entries = Object.entries(scores)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) {
    return null
  }
  if (entries.length === 1) {
    const first = entries[0]
    return first === undefined ? null : formatNumber(first[1])
  }
  return entries.map(([slot, score]) => `${formatSlot(slot)}: ${formatNumber(score)}`).join(', ')
}

export function summarizeStates(states: readonly StepState[]): RunSummary {
  const last = states.at(-1)
  // Agent state stores scores inside each slot object, while live result envelopes use slot -> score.
  const scores =
    last === undefined
      ? {}
      : Object.fromEntries(Object.entries(last.agents).map(([slot, agent]) => [slot, agent.score]))
  return {
    score: formatScoreMap(scores),
    ticks: states.length > 0 ? states.length : null,
  }
}
