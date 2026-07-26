import { describe, expect, it } from 'vitest'

import {
  projectSchedule,
  type ScheduleMatchConfig,
  ScheduleProjectionError,
} from '../src/schedule.js'

describe('projectSchedule', () => {
  it('matches ordered all-submission Spades counts for both declared layouts', () => {
    const partnership: ScheduleMatchConfig = {
      seats: ['submission', 'submission'],
      games: 2,
    }
    const solo: ScheduleMatchConfig = {
      seats: ['submission', 'submission', 'submission', 'submission'],
      games: 2,
    }

    expect(
      projectSchedule({
        matches: [partnership],
        eligibleSubmissionCount: 20,
        seatCount: 2,
        seatOrderMatters: true,
      }),
    ).toMatchObject({
      submittedAssignments: 380,
      naiveAssignments: 1,
      submittedGames: 760,
      naiveGames: 2,
      totalGames: 762,
    })
    expect(
      projectSchedule({
        matches: [solo],
        eligibleSubmissionCount: 20,
        seatCount: 4,
        seatOrderMatters: true,
      }),
    ).toMatchObject({
      submittedAssignments: 116_280,
      naiveAssignments: 1,
      submittedGames: 232_560,
      naiveGames: 2,
      totalGames: 232_562,
    })
  })

  it('uses unordered combinations and includes the appended baseline', () => {
    const projection = projectSchedule({
      matches: [{ seats: ['submission', 'submission'], games: 3 }],
      eligibleSubmissionCount: 4,
      seatCount: 2,
      seatOrderMatters: false,
    })

    expect(projection).toEqual({
      matches: [
        {
          submittedAssignments: 6,
          naiveAssignments: 1,
          submittedGames: 18,
          naiveGames: 3,
          totalGames: 21,
        },
      ],
      submittedAssignments: 6,
      naiveAssignments: 1,
      submittedGames: 18,
      naiveGames: 3,
      totalGames: 21,
    })
  })

  it('counts mixed and baseline-only rows across multiple matches', () => {
    const projection = projectSchedule({
      matches: [
        { seats: ['submission', 'builtin-naive'], games: 2 },
        { seats: ['builtin-naive', 'builtin-naive'], games: 3 },
      ],
      eligibleSubmissionCount: 3,
      seatCount: 2,
      seatOrderMatters: true,
    })

    expect(projection).toEqual({
      matches: [
        {
          submittedAssignments: 3,
          naiveAssignments: 1,
          submittedGames: 6,
          naiveGames: 2,
          totalGames: 8,
        },
        {
          submittedAssignments: 0,
          naiveAssignments: 1,
          submittedGames: 0,
          naiveGames: 3,
          totalGames: 3,
        },
      ],
      submittedAssignments: 3,
      naiveAssignments: 2,
      submittedGames: 6,
      naiveGames: 5,
      totalGames: 11,
    })
  })

  it('returns only the baseline when too few submissions can fill the row', () => {
    expect(
      projectSchedule({
        matches: [{ seats: ['submission', 'submission'], games: 2 }],
        eligibleSubmissionCount: 1,
        seatCount: 2,
        seatOrderMatters: true,
      }).matches,
    ).toEqual([
      {
        submittedAssignments: 0,
        naiveAssignments: 1,
        submittedGames: 0,
        naiveGames: 2,
        totalGames: 2,
      },
    ])
  })

  it('rejects a match whose seats do not match the resolved layout', () => {
    expect(() =>
      projectSchedule({
        matches: [{ seats: ['submission'], games: 1 }],
        eligibleSubmissionCount: 1,
        seatCount: 2,
        seatOrderMatters: false,
      }),
    ).toThrow(ScheduleProjectionError)
    try {
      projectSchedule({
        matches: [{ seats: ['submission'], games: 1 }],
        eligibleSubmissionCount: 1,
        seatCount: 2,
        seatOrderMatters: false,
      })
    } catch (error) {
      expect(error).toMatchObject({ reason: 'seat_count_mismatch', matchIndex: 0 })
    }
  })

  it('rejects unsafe exact results', () => {
    expect(() =>
      projectSchedule({
        matches: [{ seats: ['submission', 'submission'], games: 1 }],
        eligibleSubmissionCount: Number.MAX_SAFE_INTEGER,
        seatCount: 2,
        seatOrderMatters: true,
      }),
    ).toThrow(ScheduleProjectionError)
    try {
      projectSchedule({
        matches: [{ seats: ['submission', 'submission'], games: 1 }],
        eligibleSubmissionCount: Number.MAX_SAFE_INTEGER,
        seatCount: 2,
        seatOrderMatters: true,
      })
    } catch (error) {
      expect(error).toMatchObject({ reason: 'unsafe_integer', matchIndex: 0 })
    }
  })
})
