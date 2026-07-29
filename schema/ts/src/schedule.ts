/**
 * Shared arithmetic for showing a season schedule before the backend materializes it.
 *
 * This module intentionally has no runtime dependencies. The backend scheduler owns
 * concrete submission references and game rows, while the admin editor only needs the
 * exact number of assignments and games its current draft would create.
 */

/** A single resolved seat in a season match configuration. */
export type SeatSpec = 'submission' | `builtin:${string}`

const BUILTIN_SEAT_SPEC = /^builtin:([a-z][a-z0-9_]*)$/

/**
 * Parse one compact season seat spec. Builtin names use the same snake_case vocabulary as
 * environment metadata, while `submission` remains the sole non-builtin controller token.
 */
export function parseSeatSpec(value: unknown): SeatSpec | undefined {
  if (value === 'submission') return value
  if (typeof value === 'string' && BUILTIN_SEAT_SPEC.test(value)) return value as SeatSpec
  return undefined
}

/** The portion of a validated match configuration needed for schedule projection. */
export interface ScheduleMatchConfig {
  seats: readonly SeatSpec[]
  games: number
}

/** Inputs required to project a complete season schedule. */
export interface ScheduleProjectionInput {
  matches: readonly ScheduleMatchConfig[]
  eligibleSubmissionCount: number
  seatCount: number
  seatOrderMatters: boolean
}

/** The exact contribution of one configured match row. */
export interface MatchScheduleProjection {
  /** Eligible all-submission assignments, excluding the appended all-Naive assignment. */
  submittedAssignments: number
  /** The one appended all-Naive assignment for this match. */
  naiveAssignments: 1
  /** Submitted assignments after this match's game repetition. */
  submittedGames: number
  /** All-Naive games after this match's game repetition. */
  naiveGames: number
  /** All games this match contributes. */
  totalGames: number
}

/** Exact totals across every configured match row. */
export interface ScheduleProjection {
  matches: MatchScheduleProjection[]
  submittedAssignments: number
  naiveAssignments: number
  submittedGames: number
  naiveGames: number
  totalGames: number
}

/** Reasons a draft cannot be projected exactly. */
export type ScheduleProjectionErrorReason =
  | 'invalid_eligible_submission_count'
  | 'invalid_seat_count'
  | 'seat_count_mismatch'
  | 'invalid_games'
  | 'unsafe_integer'

/** A typed validation failure for an invalid or inexact schedule projection. */
export class ScheduleProjectionError extends Error {
  constructor(
    readonly reason: ScheduleProjectionErrorReason,
    readonly matchIndex: number | null,
  ) {
    super(matchIndex === null ? reason : `match ${matchIndex}: ${reason}`)
    this.name = 'ScheduleProjectionError'
  }
}

/**
 * Project schedule cardinality without constructing submission assignments.
 *
 * Submission seats expand as falling permutations when their order matters and
 * combinations when it does not. Every match also appends exactly one all-Naive
 * assignment, then repeats each assignment by its configured game count.
 */
export function projectSchedule(input: ScheduleProjectionInput): ScheduleProjection {
  const { matches, eligibleSubmissionCount, seatCount, seatOrderMatters } = input
  if (!isNonNegativeSafeInteger(eligibleSubmissionCount)) {
    throw new ScheduleProjectionError('invalid_eligible_submission_count', null)
  }
  if (!isNonNegativeSafeInteger(seatCount)) {
    throw new ScheduleProjectionError('invalid_seat_count', null)
  }

  const projection: ScheduleProjection = {
    matches: [],
    submittedAssignments: 0,
    naiveAssignments: 0,
    submittedGames: 0,
    naiveGames: 0,
    totalGames: 0,
  }

  matches.forEach((match, matchIndex) => {
    if (match.seats.length !== seatCount) {
      throw new ScheduleProjectionError('seat_count_mismatch', matchIndex)
    }
    if (!isPositiveSafeInteger(match.games)) {
      throw new ScheduleProjectionError('invalid_games', matchIndex)
    }

    const submissionSeats = match.seats.filter((seat) => seat === 'submission').length
    const submittedAssignments =
      submissionSeats === 0
        ? 0
        : seatingCount(eligibleSubmissionCount, submissionSeats, seatOrderMatters, matchIndex)
    const naiveAssignments = 1 as const
    const submittedGames = checkedInteger(submittedAssignments * match.games, matchIndex)
    const naiveGames = match.games
    const totalGames = checkedInteger(submittedGames + naiveGames, matchIndex)

    projection.matches.push({
      submittedAssignments,
      naiveAssignments,
      submittedGames,
      naiveGames,
      totalGames,
    })
  })

  // A running total is a property of the whole projection, not of any one match, so an overflow
  // here is attributed to the projection as a whole (`matchIndex: null`) rather than to whichever
  // match happened to push the sum over the safe-integer limit.
  projection.submittedAssignments = sumMatchField(
    projection.matches,
    (match) => match.submittedAssignments,
  )
  projection.naiveAssignments = sumMatchField(projection.matches, (match) => match.naiveAssignments)
  projection.submittedGames = sumMatchField(projection.matches, (match) => match.submittedGames)
  projection.naiveGames = sumMatchField(projection.matches, (match) => match.naiveGames)
  projection.totalGames = sumMatchField(projection.matches, (match) => match.totalGames)

  return projection
}

function seatingCount(
  eligibleSubmissionCount: number,
  submissionSeats: number,
  seatOrderMatters: boolean,
  matchIndex: number,
): number {
  if (submissionSeats > eligibleSubmissionCount) return 0

  let result = 1n
  const eligible = BigInt(eligibleSubmissionCount)
  for (let index = 0; index < submissionSeats; index++) {
    const numerator = eligible - BigInt(index)
    const denominator = seatOrderMatters ? 1n : BigInt(index + 1)
    result = (result * numerator) / denominator
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ScheduleProjectionError('unsafe_integer', matchIndex)
  }
  return Number(result)
}

/** Check that an arithmetic result is still an exact JS integer, or throw with the given match index. */
function checkedInteger(value: number, matchIndex: number | null): number {
  if (!Number.isSafeInteger(value)) throw new ScheduleProjectionError('unsafe_integer', matchIndex)
  return value
}

/** Sum one field across every match's projection, with a single safe-integer check for the total. */
function sumMatchField(
  matches: readonly MatchScheduleProjection[],
  select: (match: MatchScheduleProjection) => number,
): number {
  const total = matches.reduce((sum, match) => sum + select(match), 0)
  return checkedInteger(total, null)
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}
