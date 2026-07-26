/** The cross-environment final standings, reduced from player scores into resolved seats. */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { reduceSeatScore } from '@game-sandbox/schema/environment'

import { type AttributionContext, seatControllerLabel } from './attribution.js'

export type Medal = 'gold' | 'silver' | 'bronze'

export const MEDALS: readonly Medal[] = ['gold', 'silver', 'bronze']

/** One ranked seat, retaining its player members for the card's secondary detail. */
export interface Standing {
  seat: string
  label: string
  players: readonly string[]
  value: number
  medal: Medal | null
}

/**
 * Build best-first final standings. The header's seat map is authoritative: overlay arrays and
 * per-player state scores are reduced by each seat's ordered members, so one wide seat produces one
 * row. Repeated controller labels collapse, while a mixed seat puts its human controller first.
 */
export function buildStandings(
  state: StepState,
  header: RecordingHeader | null,
  attribution: AttributionContext = {},
): Standing[] {
  const overlay = state.overlay
  const leaderboard = numberArray(overlay?.leaderboard_scores)
  const displayScores = numberArray(overlay?.display_scores)
  const pipes = typeof overlay?.pipes_passed === 'number' ? overlay.pipes_passed : null
  const seats = header === null ? headerlessSeats(state, leaderboard) : Object.entries(header.seats)

  const rows = seats.flatMap(([seat, players]) => {
    const rankScores = players.map((player) => rankScoreOf(player, leaderboard, state))
    if (rankScores.some((score) => score === null)) {
      return []
    }
    const display = players.map((player) => displayScoreOf(player, displayScores))
    const rankScore = reduceSeatScore(rankScores as number[])
    const value =
      pipes !== null && players.length === 1
        ? pipes
        : display.some((score) => score === null)
          ? Math.round(rankScore)
          : reduceSeatScore(display as number[])
    return [
      {
        seat,
        label: seatControllerLabel(players, header?.players, attribution),
        players,
        value,
        rankScore,
      },
    ]
  })

  rows.sort((a, b) => b.rankScore - a.rankScore)

  let denseRank = -1
  let previous: number | null = null
  return rows.map((row) => {
    if (previous === null || row.rankScore !== previous) {
      denseRank += 1
      previous = row.rankScore
    }
    return { ...row, medal: MEDALS[denseRank] ?? null }
  })
}

/**
 * One seat per player when there is no header to group by. The overlay's leaderboard array is the
 * complete, player-indexed picture and `state.agents` is not: a recording stores only the acting
 * player each tick, so a four-player terminal frame carries just the last one. Size the seats from
 * the overlay whenever it is present, and fall back to the recorded agents only when it is not
 * (a single-player environment, where that map is complete).
 */
function headerlessSeats(state: StepState, leaderboard: number[] | null): [string, string[]][] {
  const players =
    leaderboard === null
      ? Object.keys(state.agents)
      : leaderboard.map((_score, index) => `player_${index}`)
  return players.map((player, index) => [`seat_${index}`, [player]])
}

/**
 * The score a seat ranks by: the player-indexed overlay first, then the player's recorded running
 * score. The rows come from the header's seat map rather than from the overlay array, so an overlay
 * shorter than the player count leaves a real seat with no entry at its index. Falling through to the
 * recorded score keeps that seat in the standings; without it the seat would be dropped and the card
 * would quietly show fewer competitors than played.
 */
function rankScoreOf(player: string, overlay: number[] | null, state: StepState): number | null {
  const index = playerIndex(player)
  const fromOverlay = overlay !== null && index !== null ? overlay[index] : undefined
  return fromOverlay ?? state.agents[player]?.score ?? null
}

/**
 * The environment's own displayed number for a player, or null when it ships none. Deliberately no
 * fallback to the recorded score: that value is the rank score, not a display score, and substituting
 * it would show a raw cumulative reward where the card promises the environment's natural score. A
 * null here sends the row to the rounded rank score instead.
 */
function displayScoreOf(player: string, overlay: number[] | null): number | null {
  const index = playerIndex(player)
  if (overlay === null || index === null) {
    return null
  }
  return overlay[index] ?? null
}

function playerIndex(player: string): number | null {
  const match = /^player_(\d+)$/.exec(player)
  return match === null ? null : Number(match[1])
}

function numberArray(value: unknown): number[] | null {
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? (value as number[])
    : null
}
