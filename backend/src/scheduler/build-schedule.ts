/**
 * The pure matchmaking scheduler: it turns a season's match design plus its trigger-time
 * ready-submission snapshot into the concrete, ordered list of games the runner executes.
 *
 * This is the Stage 6.2 scheduler (`plans/stage-06/2-matchmaking-schedule.md`) carrying the Stage
 * 7 multi-seat generalization (`plans/stage-07-multi-agent.md`). It has no I/O, no Docker, and no
 * database: plain inputs in, a plain `ScheduledGameInput[]` out, so the balancing rules are unit
 * tested exhaustively without containers. The runner never re-reads live submissions. It executes
 * exactly this list in order.
 *
 * Determinism is the whole point: submissions are sorted by stable id before any expansion, seatings
 * are enumerated in fixed lexicographic order, seeds round-robin by run index, and the Naive baseline
 * is always appended after the submitted rows of each match. The same inputs always yield the same
 * ordered schedule, so a re-run reproduces a deterministic agent's games exactly.
 */

import type { ScheduledGameInput } from '../storage/index.js'
import type { AgentRef, SubmissionRef } from '../storage/schema.js'
import type { MatchConfig, SeatSpec } from '../storage/season-config.js'

export type { SubmissionRef } from '../storage/schema.js'

/** The shared built-in baseline seat ref. It is not a submission row. */
const NAIVE: AgentRef = { kind: 'builtin-naive' }

/** The typed rejection reasons. Each names a structurally invalid match the codec also rejects. */
export type ScheduleErrorReason = 'zero_seats' | 'empty_seeds' | 'non_positive_games'

/**
 * Thrown when a match configuration is structurally unrunnable. The {@link SeasonConfig} codec
 * already rejects these at write time; the scheduler guards again so a hand-built or corrupted
 * snapshot fails loudly here rather than producing a partial schedule.
 */
export class ScheduleError extends Error {
  constructor(
    readonly reason: ScheduleErrorReason,
    readonly matchIndex: number,
  ) {
    super(`match ${matchIndex}: ${reason}`)
    this.name = 'ScheduleError'
  }
}

/** Inputs to {@link buildSchedule}: the match design, the live roster, and the seat-order capability. */
export interface BuildScheduleInput {
  /** The season's match configurations, in order; the `match_index` is the array index. */
  matches: readonly MatchConfig[]
  /** The trigger-time snapshot of active `ready` submitted agents eligible to fill submission seats. */
  submissions: readonly SubmissionRef[]
  /**
   * The environment's `seat_order_matters` capability. `true` expands K submission seats as ordered
   * permutations (positional games like Hearts); `false` as unordered combinations seated in sorted
   * id order (symmetric games). For a single submission seat the two coincide.
   */
  seatOrderMatters: boolean
  /** The resolved layout key persisted beside every scheduled assignment. */
  seatPlan: string
}

/**
 * Expand a match design over its live submissions into the ordered, fully-resolved game list.
 *
 * For each match, the fixed `builtin-naive` seats keep the baseline ref and the `submission` seats
 * are filled from the sorted snapshot: `P(N, K)` ordered seatings when `seatOrderMatters`, else
 * `C(N, K)` unordered rosters. Each seating emits `games` runs with seeds cycling by run index. The
 * Naive baseline (every submission seat filled with `builtin-naive`) is always appended once, so the
 * board has a comparable baseline row even with zero ready submissions. A match with no submission
 * seat is just that baseline. `game_index` is a single deterministic counter across the whole run.
 * Keep enumeration changes aligned with `projectSchedule`; the shared-projection test in
 * `backend/test/scheduler/build-schedule.test.ts` cross-checks their per-match and total counts.
 */
export function buildSchedule(input: BuildScheduleInput): ScheduledGameInput[] {
  const { matches, submissions, seatOrderMatters, seatPlan } = input

  // Sort by stable submission id once; every seat expansion below enumerates over this order, so the
  // concrete schedule is identical across re-runs regardless of snapshot season order.
  const roster = [...submissions].sort((a, b) => compareIds(a.submission_id, b.submission_id))

  const schedule: ScheduledGameInput[] = []
  let gameIndex = 0

  matches.forEach((match, matchIndex) => {
    // Defensive guards; the codec enforces these too (see season-config.ts).
    if (match.seats.length === 0) throw new ScheduleError('zero_seats', matchIndex)
    if (match.seeds.length === 0) throw new ScheduleError('empty_seeds', matchIndex)
    if (match.games <= 0) throw new ScheduleError('non_positive_games', matchIndex)

    const k = match.seats.filter((spec) => spec === 'submission').length

    const emit = (seats: AgentRef[]): void => {
      for (let run = 0; run < match.games; run++) {
        schedule.push({
          match_index: matchIndex,
          game_index: gameIndex++,
          seed: match.seeds[run % match.seeds.length] as number,
          seats: [...seats],
          seat_plan: seatPlan,
        })
      }
    }

    // Submitted rows first, in deterministic enumeration order. Empty when K is 0 (pure baseline) or
    // fewer than K submissions are ready (N < K), both fall through to the baseline-only schedule.
    const seatings =
      k === 0 ? [] : seatOrderMatters ? permutations(roster, k) : combinations(roster, k)
    for (const seating of seatings) emit(resolveSeats(match.seats, seating))

    // The Naive baseline always runs, after the submitted rows, on the same seeds and count.
    emit(resolveSeats(match.seats, null))
  })

  return schedule
}

/**
 * Resolve one concrete seat assignment from a match's seat specs and a chosen seating.
 *
 * `builtin-naive` specs take the baseline ref. `submission` specs are filled left-to-right from
 * `seating`; a `null` seating fills every submission seat with the baseline, which is how the
 * always-present Naive baseline row resolves. `buildSchedule` only ever passes a full-length seating
 * or `null`, since it enumerates distinct full seatings and emits the baseline separately.
 *
 * Repeated refs are intentional and never deduped or rejected: the baseline repeats `builtin-naive`
 * across every submission seat, and a self-play seating may repeat one submission across seats. The
 * downstream image build and harness (Stage 7.5) load an independent instance per seat.
 */
export function resolveSeats(
  seats: readonly SeatSpec[],
  seating: readonly SubmissionRef[] | null,
): AgentRef[] {
  let submissionIndex = 0
  return seats.map((spec) => {
    if (spec === 'builtin-naive') return NAIVE
    return seating?.[submissionIndex++] ?? NAIVE
  })
}

/** Stable string compare, independent of locale, for deterministic submission ordering. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Lexicographic K-combinations (ascending, no repeats) over `items`; empty when `k > items.length`. */
function combinations<T>(items: readonly T[], k: number): T[][] {
  const result: T[][] = []
  const choose = (start: number, prefix: T[]): void => {
    if (prefix.length === k) {
      result.push(prefix)
      return
    }
    for (let i = start; i < items.length; i++) choose(i + 1, [...prefix, items[i] as T])
  }
  choose(0, [])
  return result
}

/** Lexicographic K-permutations (ordered, distinct) over `items`; empty when `k > items.length`. */
function permutations<T>(items: readonly T[], k: number): T[][] {
  const result: T[][] = []
  const used = new Array<boolean>(items.length).fill(false)
  const build = (prefix: T[]): void => {
    if (prefix.length === k) {
      result.push(prefix)
      return
    }
    for (let i = 0; i < items.length; i++) {
      if (used[i]) continue
      used[i] = true
      build([...prefix, items[i] as T])
      used[i] = false
    }
  }
  build([])
  return result
}
