/**
 * Unit coverage for the pure matchmaking scheduler (Stage 6.2 + the Stage 7 multi-seat expansion).
 *
 * No Docker, no DB: it pins the balancing rules directly. The single-submission-seat Flappy Bird
 * case, the always-present Naive baseline, seed round-robin, deterministic re-runs, and the typed
 * guards are the Stage 6.2 contract. The ordered-vs-unordered multi-seat expansion driven by an
 * environment's `seat_order_matters`, the `K = 1` reduction proving the multi-seat expansion is a
 * strict generalization of the single-seat path, and the `N < K` baseline-only fallthrough are the
 * Stage 7 additions.
 */
import { describe, expect, it } from 'vitest'

import {
  buildSchedule,
  ScheduleError,
  type SubmissionRef,
} from '../../src/scheduler/build-schedule.js'
import type { MatchConfig } from '../../src/storage/season-config.js'

/** Build N submission refs with deterministic, sortable ids `s1..sN` (and matching user ids). */
function subs(n: number): SubmissionRef[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'submission' as const,
    submission_id: `s${i + 1}`,
    user_id: `u${i + 1}`,
  }))
}

/** Compact a resolved slots array into a readable token list for assertions. */
function ids(slots: readonly { kind: string; submission_id?: string }[]): string[] {
  return slots.map((s) => (s.kind === 'submission' ? (s.submission_id as string) : 'naive'))
}

describe('buildSchedule - single submission seat (Flappy Bird)', () => {
  const match: MatchConfig = { slots: ['submission'], seeds: [10, 20], games: 2 }

  it('emits two games per submission plus two baseline games, in deterministic order', () => {
    const schedule = buildSchedule({
      matches: [match],
      submissions: subs(3),
      seatOrderMatters: false,
    })

    // 3 submissions x 2 games + 1 baseline x 2 games = 8.
    expect(schedule).toHaveLength(8)
    // game_index is a contiguous run-global counter.
    expect(schedule.map((g) => g.game_index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // Submitted rows first (sorted s1, s2, s3), baseline last.
    expect(schedule.map((g) => ids(g.slots))).toEqual([
      ['s1'],
      ['s1'],
      ['s2'],
      ['s2'],
      ['s3'],
      ['s3'],
      ['naive'],
      ['naive'],
    ])
    // Seeds round-robin by run index within each assignment.
    expect(schedule.map((g) => g.seed)).toEqual([10, 20, 10, 20, 10, 20, 10, 20])
  })

  it('is deterministic regardless of snapshot order and across re-runs', () => {
    const ordered = subs(3)
    const shuffled = [ordered[2], ordered[0], ordered[1]] as SubmissionRef[]
    const a = buildSchedule({ matches: [match], submissions: shuffled, seatOrderMatters: false })
    const b = buildSchedule({ matches: [match], submissions: ordered, seatOrderMatters: false })
    expect(a).toEqual(b)
  })

  it('always includes the Naive baseline, even with zero ready submissions', () => {
    const schedule = buildSchedule({ matches: [match], submissions: [], seatOrderMatters: false })
    expect(schedule.map((g) => ids(g.slots))).toEqual([['naive'], ['naive']])
    expect(schedule.map((g) => g.seed)).toEqual([10, 20])
  })

  it('scales per-assignment run count with games and cycles a longer seed list', () => {
    const five: MatchConfig = { slots: ['submission'], seeds: [10, 20], games: 5 }
    const schedule = buildSchedule({
      matches: [five],
      submissions: subs(1),
      seatOrderMatters: false,
    })
    // One submission + baseline, 5 games each = 10.
    expect(schedule).toHaveLength(10)
    // seeds[i % 2] => 10,20,10,20,10 for each assignment.
    expect(schedule.slice(0, 5).map((g) => g.seed)).toEqual([10, 20, 10, 20, 10])
  })

  it('fills accompanying builtin-naive seats while expanding the submission seat', () => {
    const mixed: MatchConfig = { slots: ['submission', 'builtin-naive'], seeds: [1], games: 1 }
    const schedule = buildSchedule({
      matches: [mixed],
      submissions: subs(2),
      seatOrderMatters: false,
    })
    expect(schedule.map((g) => ids(g.slots))).toEqual([
      ['s1', 'naive'],
      ['s2', 'naive'],
      ['naive', 'naive'], // baseline
    ])
  })
})

describe('buildSchedule - multi-seat expansion', () => {
  // Hearts shape: one fixed Naive seat, two submission seats.
  const hearts: MatchConfig = {
    slots: ['submission', 'submission', 'builtin-naive'],
    seeds: [7, 8],
    games: 2,
  }

  it('ordered (seat_order_matters=true) yields P(4,2)=12 seatings x 2 seeds + baseline = 26', () => {
    const schedule = buildSchedule({
      matches: [hearts],
      submissions: subs(4),
      seatOrderMatters: true,
    })
    expect(schedule).toHaveLength(26)

    const submitted = schedule.slice(0, 24)
    // Distinct ordered seatings (ignoring the repeated-per-seed runs): 12 of them, lexicographic.
    const seatings = submitted.filter((_, i) => i % 2 === 0).map((g) => ids(g.slots))
    expect(seatings).toEqual([
      ['s1', 's2', 'naive'],
      ['s1', 's3', 'naive'],
      ['s1', 's4', 'naive'],
      ['s2', 's1', 'naive'],
      ['s2', 's3', 'naive'],
      ['s2', 's4', 'naive'],
      ['s3', 's1', 'naive'],
      ['s3', 's2', 'naive'],
      ['s3', 's4', 'naive'],
      ['s4', 's1', 'naive'],
      ['s4', 's2', 'naive'],
      ['s4', 's3', 'naive'],
    ])
    // Baseline last: both submission seats Naive.
    expect(schedule.slice(24).map((g) => ids(g.slots))).toEqual([
      ['naive', 'naive', 'naive'],
      ['naive', 'naive', 'naive'],
    ])
  })

  it('unordered (seat_order_matters=false) yields C(4,2)=6 rosters x 2 seeds + baseline = 14', () => {
    const schedule = buildSchedule({
      matches: [hearts],
      submissions: subs(4),
      seatOrderMatters: false,
    })
    expect(schedule).toHaveLength(14)
    const rosters = schedule
      .slice(0, 12)
      .filter((_, i) => i % 2 === 0)
      .map((g) => ids(g.slots))
    // Sorted-id order within each roster; lexicographic across rosters; no mirrored pairs.
    expect(rosters).toEqual([
      ['s1', 's2', 'naive'],
      ['s1', 's3', 'naive'],
      ['s1', 's4', 'naive'],
      ['s2', 's3', 'naive'],
      ['s2', 's4', 'naive'],
      ['s3', 's4', 'naive'],
    ])
  })

  it('reduces to the exact Stage 6 schedule for K=1 under either flag', () => {
    const m: MatchConfig = { slots: ['submission'], seeds: [1, 2], games: 2 }
    const ordered = buildSchedule({ matches: [m], submissions: subs(3), seatOrderMatters: true })
    const unordered = buildSchedule({ matches: [m], submissions: subs(3), seatOrderMatters: false })
    expect(ordered).toEqual(unordered)
    expect(ordered.map((g) => ids(g.slots))).toEqual([
      ['s1'],
      ['s1'],
      ['s2'],
      ['s2'],
      ['s3'],
      ['s3'],
      ['naive'],
      ['naive'],
    ])
  })

  it('emits baseline-only when fewer submissions are ready than submission seats (N < K)', () => {
    const oneSub = buildSchedule({
      matches: [hearts],
      submissions: subs(1),
      seatOrderMatters: true,
    })
    expect(oneSub.map((g) => ids(g.slots))).toEqual([
      ['naive', 'naive', 'naive'],
      ['naive', 'naive', 'naive'],
    ])
  })

  it('runs the all-submission board with no fixed builtin seat', () => {
    const board: MatchConfig = { slots: ['submission', 'submission'], seeds: [1], games: 1 }
    const schedule = buildSchedule({
      matches: [board],
      submissions: subs(3),
      seatOrderMatters: true,
    })
    // P(3,2) = 6 ordered seatings + 1 baseline.
    expect(schedule.map((g) => ids(g.slots))).toEqual([
      ['s1', 's2'],
      ['s1', 's3'],
      ['s2', 's1'],
      ['s2', 's3'],
      ['s3', 's1'],
      ['s3', 's2'],
      ['naive', 'naive'],
    ])
  })
})

describe('buildSchedule - match composition and guards', () => {
  it('returns an empty schedule for an empty match list', () => {
    expect(buildSchedule({ matches: [], submissions: subs(3), seatOrderMatters: false })).toEqual(
      [],
    )
  })

  it('treats a no-submission-seat match as a single baseline run per game count', () => {
    const pure: MatchConfig = { slots: ['builtin-naive'], seeds: [5, 6], games: 2 }
    const schedule = buildSchedule({
      matches: [pure],
      submissions: subs(3),
      seatOrderMatters: true,
    })
    expect(schedule.map((g) => ids(g.slots))).toEqual([['naive'], ['naive']])
    expect(schedule.map((g) => g.seed)).toEqual([5, 6])
  })

  it('numbers game_index globally across multiple matches', () => {
    const m1: MatchConfig = { slots: ['submission'], seeds: [1], games: 1 }
    const m2: MatchConfig = { slots: ['builtin-naive'], seeds: [1], games: 1 }
    const schedule = buildSchedule({
      matches: [m1, m2],
      submissions: subs(2),
      seatOrderMatters: false,
    })
    expect(schedule.map((g) => g.game_index)).toEqual([0, 1, 2, 3])
    expect(schedule.map((g) => g.match_index)).toEqual([0, 0, 0, 1])
  })

  const badMatches: Array<[string, MatchConfig]> = [
    ['zero_slots', { slots: [], seeds: [1], games: 1 }],
    ['empty_seeds', { slots: ['submission'], seeds: [], games: 1 }],
    ['non_positive_games', { slots: ['submission'], seeds: [1], games: 0 }],
  ]
  it.each(badMatches)('rejects %s with a typed ScheduleError', (reason, badMatch) => {
    const run = () =>
      buildSchedule({ matches: [badMatch], submissions: subs(1), seatOrderMatters: false })
    expect(run).toThrow(ScheduleError)
    try {
      run()
    } catch (err) {
      expect(err).toBeInstanceOf(ScheduleError)
      expect((err as ScheduleError).reason).toBe(reason)
      expect((err as ScheduleError).matchIndex).toBe(0)
    }
  })
})
