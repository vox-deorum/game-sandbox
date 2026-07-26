/**
 * Pure aggregation of one player's outcome from a recording's per-step states.
 *
 * The workflow runner does not re-measure anything: it reads back the recording the harness already
 * produced and sums the per-tick fields. For one player this yields the two timing numbers the
 * `game_results` row carries, its total agent compute time and how many ticks contributed that time,
 * per [leaderboard.md](../../../docs/specs/leaderboard.md). Kept pure and free of storage or Docker so
 * the arithmetic is unit-tested directly against canned states.
 *
 * Scores do not come from here. The harness `result` envelope is the only score source, because the
 * recording writes only the acting player each tick and a terminal-scored game (Hearts settles on the
 * final trick) would read back a stale value for every other player. An envelope that does not report
 * one finite score for every resolved player is a game-level fault: every seat forfeits, rather than
 * one seat falling back to a partial recording score.
 *
 * Compute time is `decision_ms + learn_ms + chat_ms` summed over the player's timing-bearing ticks.
 * `learn_ms` is present only for learning agents and `chat_ms` only on a tick the chat hook ran, so an
 * absent value is treated as zero. There is no single recorded "acted tick count" field; it is derived
 * as the count of ticks that carry this player's timing. When LLM-wait timing lands it is added to the
 * same per-tick total here, and the runner keeps only aggregating.
 */
import type { StepState } from '@game-sandbox/schema'
import { type ResolvedLayout, reduceSeatScore } from '@game-sandbox/schema/environment'
import type { ModelAlias } from '../llm/types.js'
import type { LlmUsageByModel } from '../storage/index.js'

/** One player's aggregated outcome over a recording's states. */
export interface PlayerAggregate {
  /** Sum of `decision_ms + learn_ms + chat_ms` over the player's timing-bearing ticks. */
  agentComputeMsTotal: number
  /** The number of ticks that carried this player's timing and contributed to the total. */
  actedTickCount: number
}

/**
 * Aggregate one player's contribution across a recording's per-step states. Compute time and tick
 * count come from the ticks that carry the player's `timing.decision_ms`, with `learn_ms` and
 * `chat_ms` folded in (zero when absent).
 */
export function aggregatePlayer(states: readonly StepState[], playerId: string): PlayerAggregate {
  let agentComputeMsTotal = 0
  let actedTickCount = 0
  for (const state of states) {
    const timing = state.agents[playerId]?.timing
    if (timing !== undefined && typeof timing.decision_ms === 'number') {
      agentComputeMsTotal += timing.decision_ms + (timing.learn_ms ?? 0) + (timing.chat_ms ?? 0)
      actedTickCount += 1
    }
  }
  return { agentComputeMsTotal, actedTickCount }
}

/**
 * One scored outcome. The reduction sums or averages these fields across a seat's members, so a
 * player result and the seat result it feeds carry exactly the same shape under different ids.
 */
export interface Outcome {
  episodeScore: number
  agentComputeMsTotal: number
  actedTickCount: number
  llmUsageByModel: LlmUsageByModel | null
  llmWeightedCost: number | null
  failed: boolean
  failureReason: string | null
}

/** Complete per-player outcome before the resolved layout reduces it to one row per seat. */
export type PlayerResult = Outcome & { playerId: string }

/** The result stored for one resolved seat after all of its player outcomes have been reduced. */
export type SeatResult = Outcome & { seatId: string }

/**
 * Reduce complete player outcomes to the layout's ordered seats. The input must name precisely the
 * resolved players and every score must be finite. A malformed score envelope is a game-level fault,
 * so callers can mark every seat failed rather than silently retaining a partial result.
 */
export function reducePlayersToSeats(
  layout: ResolvedLayout,
  playerResults: readonly PlayerResult[],
): SeatResult[] {
  const expected = layout.seats.flatMap((seat) => seat.players)
  const byPlayer = new Map(playerResults.map((result) => [result.playerId, result]))
  if (byPlayer.size !== playerResults.length || byPlayer.size !== expected.length) {
    throw new Error('player results do not exactly match the resolved layout')
  }
  for (const playerId of expected) {
    const result = byPlayer.get(playerId)
    if (result === undefined || !Number.isFinite(result.episodeScore)) {
      throw new Error(`missing or nonfinite score for ${playerId}`)
    }
  }
  return layout.seats.map((seat) => {
    const members = seat.players.map((playerId) => byPlayer.get(playerId) as PlayerResult)
    const usage = mergeLlmUsage(members.map((member) => member.llmUsageByModel))
    const failing = members.find((member) => member.failed)
    return {
      seatId: seat.seatId,
      episodeScore: reduceSeatScore(members.map((member) => member.episodeScore)),
      agentComputeMsTotal: members.reduce((sum, member) => sum + member.agentComputeMsTotal, 0),
      actedTickCount: members.reduce((sum, member) => sum + member.actedTickCount, 0),
      llmUsageByModel: usage,
      llmWeightedCost: sumNullable(members.map((member) => member.llmWeightedCost)),
      failed: failing !== undefined,
      failureReason:
        failing === undefined
          ? null
          : `player ${failing.playerId}: ${failing.failureReason ?? 'failed'}`,
    }
  })
}

/** Mark each already-reduced seat failed for a game-level fault that names no player. */
export function failAllSeats(seats: readonly SeatResult[], reason: string): SeatResult[] {
  return seats.map((seat) => ({ ...seat, failed: true, failureReason: reason }))
}

function sumNullable(values: readonly (number | null)[]): number | null {
  if (values.every((value) => value === null)) return null
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function mergeLlmUsage(values: readonly (LlmUsageByModel | null)[]): LlmUsageByModel | null {
  const merged: LlmUsageByModel = {}
  for (const usage of values) {
    if (usage === null) continue
    for (const [model, value] of Object.entries(usage) as [
      ModelAlias,
      NonNullable<LlmUsageByModel[ModelAlias]>,
    ][]) {
      const prior = merged[model]
      merged[model] = {
        calls: (prior?.calls ?? 0) + value.calls,
        input_tokens: (prior?.input_tokens ?? 0) + value.input_tokens,
        reasoning_tokens: (prior?.reasoning_tokens ?? 0) + value.reasoning_tokens,
        output_tokens: (prior?.output_tokens ?? 0) + value.output_tokens,
        estimated_calls: (prior?.estimated_calls ?? 0) + value.estimated_calls,
        latency_ms: (prior?.latency_ms ?? 0) + value.latency_ms,
      }
    }
  }
  return Object.keys(merged).length === 0 ? null : merged
}
