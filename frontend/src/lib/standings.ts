/**
 * The cross-environment final standings shown on the host-level game-over screen, built from a
 * terminal step state. This is the web twin of `scripts/play.py` `_standings`; both rank slots
 * best-first and show each game's natural score, so the leaderboard reads the same in the browser and
 * in Python local play.
 *
 * One asymmetry of data source: local play accumulates a live per-seat reward tally across the
 * episode, but a recording stores only the *acting* agent each tick (a four-seat Hearts terminal
 * frame carries just the last player in `state.agents`). So the web reads the complete, seat-indexed
 * overlay — `leaderboard_scores` (higher-is-better at terminal, so the gold cup goes to the winner)
 * for the rank, `display_scores` for the displayed penalty points — falling back to the `agents` map
 * only for a single-slot env (Flappy Bird), where it is complete and the overlay ships no seat array.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'

import { type AttributionContext, attributionLabel } from './attribution.js'

/** The cup awarded to a podium finisher; index = rank (0 = first). */
export type Medal = 'gold' | 'silver' | 'bronze'

/** Cups for the top three finishers, best-first. */
export const MEDALS: readonly Medal[] = ['gold', 'silver', 'bronze']

/** One ranked row of the cross-environment game-over leaderboard. */
export interface Standing {
  slot: string
  label: string
  /** The game's natural score to display (Hearts penalty points, Flappy Bird pipes passed). */
  value: number
  /** The cup for a top-three finisher, or null below the podium. */
  medal: Medal | null
}

/** The intermediate row carries the rank score, dropped once the rows are sorted and given cups. */
interface RankedRow {
  slot: string
  label: string
  value: number
  rankScore: number
}

/**
 * Build the final standings from a terminal step state, best-first. `header` supplies the per-slot
 * display labels (absent on older recordings → a slot fallback) and `attribution` the viewer's blind
 * policy, both via the shared `attributionLabel`. The displayed value is the environment's natural
 * score, chosen overlay-first (the lockstep twin of play.py `_standings`):
 *   - `display_scores[seat]` for each seat the overlay's `leaderboard_scores` ranks (Hearts), else
 *   - `pipes_passed` for a single-slot game (Flappy Bird), else
 *   - the rounded cumulative score for any environment that ships no overlay score.
 */
export function buildStandings(
  state: StepState,
  header: RecordingHeader | null,
  attribution: AttributionContext = {},
): Standing[] {
  const players = header?.players
  const overlay = state.overlay
  const leaderboard = numberArray(overlay?.leaderboard_scores)
  const displayScores = numberArray(overlay?.display_scores)
  const pipes = typeof overlay?.pipes_passed === 'number' ? overlay.pipes_passed : null

  const label = (slot: string): string => attributionLabel(slot, players?.[slot], attribution)

  // Prefer the complete seat-indexed overlay over the per-tick `agents` map (see the module note).
  const rows: RankedRow[] =
    leaderboard !== null
      ? leaderboard.map((rankScore, seat) => {
          const slot = `player_${seat}`
          const seatValue = displayScores?.[seat]
          return {
            slot,
            label: label(slot),
            value: typeof seatValue === 'number' ? seatValue : Math.round(rankScore),
            rankScore,
          }
        })
      : Object.entries(state.agents).map(([slot, agent]) => ({
          slot,
          label: label(slot),
          value: pipes ?? Math.round(agent.score),
          rankScore: agent.score,
        }))

  // Higher rank score wins everywhere (Hearts' leaderboard score, Flappy's reward total); a stable
  // sort keeps tied seats in seat order.
  rows.sort((a, b) => b.rankScore - a.rankScore)
  return rows.map((row, i) => ({
    slot: row.slot,
    label: row.label,
    value: row.value,
    medal: MEDALS[i] ?? null,
  }))
}

/** The value if it is an all-number array (a seat-indexed overlay score), else null. */
function numberArray(value: unknown): number[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
    ? (value as number[])
    : null
}
