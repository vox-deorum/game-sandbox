import { describe, expect, it } from 'vitest'

import { reducePlayersToSeats } from '../../src/workflow/aggregate.js'

describe('reducePlayersToSeats', () => {
  it('averages scores and sums player consumption in noncontiguous seat order', () => {
    const results = reducePlayersToSeats(
      {
        planKey: 'partners',
        playerCount: 3,
        seatCount: 2,
        seats: [
          { seatId: 'seat_0', players: ['player_0', 'player_2'], restrictedBuiltin: null },
          { seatId: 'seat_1', players: ['player_1'], restrictedBuiltin: null },
        ],
      },
      [
        player('player_0', 4, 10, 1),
        player('player_1', 7, 5, 1),
        player('player_2', 8, 30, 3, true),
      ],
    )

    expect(results[0]).toMatchObject({
      seatId: 'seat_0',
      episodeScore: 6,
      agentComputeMsTotal: 40,
      actedTickCount: 4,
      failed: true,
    })
    expect(results[0]?.failureReason).toContain('player_2')
    expect(results[1]).toMatchObject({ seatId: 'seat_1', episodeScore: 7, failed: false })
  })

  it('rejects a missing player score rather than reducing a partial result', () => {
    expect(() =>
      reducePlayersToSeats(
        {
          planKey: 'solo',
          playerCount: 1,
          seatCount: 1,
          seats: [{ seatId: 'seat_0', players: ['player_0'], restrictedBuiltin: null }],
        },
        [],
      ),
    ).toThrow(/player results/)
  })

  it('keeps the per-decision mean invariant across an uneven one-plus-three layout', () => {
    const usage = {
      small: {
        calls: 1,
        estimated_calls: 0,
        input_tokens: 2,
        reasoning_tokens: 1,
        output_tokens: 3,
        latency_ms: 4,
      },
    }
    const seats = reducePlayersToSeats(
      {
        planKey: 'uneven',
        playerCount: 4,
        seatCount: 2,
        seats: [
          { seatId: 'seat_0', players: ['player_0'], restrictedBuiltin: null },
          {
            seatId: 'seat_1',
            players: ['player_1', 'player_2', 'player_3'],
            restrictedBuiltin: null,
          },
        ],
      },
      [
        { ...player('player_0', 1, 10, 1), llmUsageByModel: usage, llmWeightedCost: 2 },
        { ...player('player_1', 2, 20, 2), llmUsageByModel: usage, llmWeightedCost: 2 },
        { ...player('player_2', 3, 30, 3), llmUsageByModel: usage, llmWeightedCost: 2 },
        { ...player('player_3', 4, 40, 4), llmUsageByModel: usage, llmWeightedCost: 2 },
      ],
    )
    expect(seats[1]).toMatchObject({
      agentComputeMsTotal: 90,
      actedTickCount: 9,
      llmWeightedCost: 6,
    })
    expect(seats[1]?.llmUsageByModel?.small).toMatchObject({ calls: 3, input_tokens: 6 })
    expect(((seats[0]?.agentComputeMsTotal ?? 0) + (seats[1]?.agentComputeMsTotal ?? 0)) / 10).toBe(
      10,
    )
  })
})

function player(
  playerId: string,
  episodeScore: number,
  agentComputeMsTotal: number,
  actedTickCount: number,
  failed = false,
) {
  return {
    playerId,
    episodeScore,
    agentComputeMsTotal,
    actedTickCount,
    llmUsageByModel: null,
    llmWeightedCost: null,
    failed,
    failureReason: failed ? 'agent crashed' : null,
  }
}
