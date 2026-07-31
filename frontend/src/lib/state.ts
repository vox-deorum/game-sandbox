import type { StepState } from '@game-sandbox/schema'

/** One action-bearing player entry shown in the shared decision log. */
export interface DecisionEntry {
  tick: number
  player: string
  action: unknown
}

export type PlayerScoreMap = Record<string, number>

// Recordings do not store the trailing result envelope, so replay and terminal-session pages derive
// their final score and tick count from the readable state prefix instead.
export interface RunSummary {
  score: string | null
  ticks: number | null
  scores: PlayerScoreMap
}

/** Keep only finite numeric entries, so ranking arithmetic downstream never sees NaN or junk. */
export function toPlayerScores(value: unknown): PlayerScoreMap {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const scores: PlayerScoreMap = {}
  for (const [player, score] of Object.entries(value)) {
    if (typeof score === 'number' && Number.isFinite(score)) {
      scores[player] = score
    }
  }
  return scores
}

/** Preserve the state's canonical player order while omitting actionless reward and lifecycle deltas.
 * Reward-only entries omit the `action` key entirely, never setting it to null, so `Object.hasOwn` is
 * the exact presence test promised by the harness's `build_agent_step` contract. */
export function decisionEntries(state: StepState): DecisionEntry[] {
  return Object.entries(state.agents).flatMap(([player, entry]) =>
    Object.hasOwn(entry, 'action') ? [{ tick: state.tick, player, action: entry.action }] : [],
  )
}

/** Retain the newest cumulative score recorded for every player across an ordered state sequence. */
export function latestPlayerScores(states: readonly StepState[]): PlayerScoreMap {
  const scores: PlayerScoreMap = {}
  for (const state of states) {
    for (const [player, entry] of Object.entries(state.agents)) {
      // Live transport frames are cast without validation, so keep malformed values out of score maps.
      if (Number.isFinite(entry.score)) {
        scores[player] = entry.score
      }
    }
  }
  return scores
}
