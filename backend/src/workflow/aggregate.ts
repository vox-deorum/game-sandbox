/**
 * Pure aggregation of one seat's outcome from a recording's per-step states.
 *
 * The workflow runner does not re-measure anything: it reads back the recording the harness already
 * produced and sums the per-tick fields. For one slot this yields three numbers the `game_results`
 * row carries — the seat's final score, its total agent compute time, and how many ticks contributed
 * that time — per [leaderboard.md](../../../docs/specs/leaderboard.md). Kept pure and free of storage
 * or Docker so the arithmetic is unit-tested directly against canned states.
 *
 * Compute time is `decision_ms + learn_ms + chat_ms` summed over the slot's timing-bearing ticks.
 * `learn_ms` is present only for learning agents and `chat_ms` only on a tick the chat hook ran, so an
 * absent value is treated as zero. There is no single recorded "acted tick count" field; it is derived
 * as the count of ticks that carry this slot's timing. When LLM-wait timing lands it is added to the
 * same per-tick total here, and the runner keeps only aggregating.
 */
import type { StepState } from '@game-sandbox/schema'

/** One seat's aggregated outcome over a recording's states. */
export interface SeatAggregate {
  /** The seat's final cumulative score, or null when no readable state carried it. */
  finalScore: number | null
  /** Sum of `decision_ms + learn_ms + chat_ms` over the seat's timing-bearing ticks. */
  agentComputeMsTotal: number
  /** The number of ticks that carried this seat's timing and contributed to the total. */
  actedTickCount: number
}

/**
 * Aggregate one slot's contribution across a recording's per-step states. The final score is the last
 * state that reported the slot's `score`; compute time and tick count come from the ticks that carry
 * the slot's `timing.decision_ms`, with `learn_ms` and `chat_ms` folded in (zero when absent).
 */
export function aggregateSeat(states: readonly StepState[], slotId: string): SeatAggregate {
  let finalScore: number | null = null
  let agentComputeMsTotal = 0
  let actedTickCount = 0
  for (const state of states) {
    const agent = state.agents[slotId]
    if (agent === undefined) {
      continue
    }
    if (typeof agent.score === 'number') {
      finalScore = agent.score
    }
    const timing = agent.timing
    if (timing !== undefined && typeof timing.decision_ms === 'number') {
      agentComputeMsTotal += timing.decision_ms + (timing.learn_ms ?? 0) + (timing.chat_ms ?? 0)
      actedTickCount += 1
    }
  }
  return { finalScore, agentComputeMsTotal, actedTickCount }
}
