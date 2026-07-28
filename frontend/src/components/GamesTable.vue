<!--
  A run's scheduled games as a table. Each row identifies the game (m{match}·g{game}·seed), names the
  agents in its seats, shows its status — the live overlay while a run streams, else the persisted
  status — and links to the game's replay once a recording exists. A game with no recording yet (still
  pending/running, or a failure that produced none) shows an em dash.

  Shared chrome: the operator run-details page renders it with a live per-game status overlay, and the
  public released-season page renders it as a static matchup table (no overlay) so a reader can reach
  every game of a multi-seat matchup, not just the board's one representative replay per agent.
-->
<script setup lang="ts">
import { RouterLink } from 'vue-router'

import type { BoardAgentRef, GameStatus, RunGameView } from '../api/client.js'
import UiStatusBadge from './ui/UiStatusBadge.vue'

const props = defineProps<{
  games: RunGameView[]
  /** Live per-game status overlay keyed by game_index; falls back to the persisted status. */
  liveStatus: Record<number, GameStatus>
}>()

const STATUS_TONE: Record<GameStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral',
  running: 'warning',
  completed: 'success',
  failed: 'danger',
  timed_out: 'danger',
  cancelled: 'neutral',
}

/** The effective status of a game: the live overlay if present, else the persisted status. */
function gameStatus(gameIndex: number, persisted: GameStatus): GameStatus {
  return props.liveStatus[gameIndex] ?? persisted
}

/** A seat's agent label: the owner's display name (or id) for a submission, "Naive" for the builtin baseline. */
function seatLabel(seat: BoardAgentRef): string {
  return seat.kind === 'submission' ? (seat.user_name ?? seat.user_id) : seat.name
}

/** A compact one-line summary of the agents in a game's seats, in seat order. */
function playersSummary(seats: BoardAgentRef[]): string {
  return seats.length === 0 ? '—' : seats.map(seatLabel).join(' · ')
}

/** The stable ids behind a game's submission seats, joined for a tooltip. Blind masking never
 *  applies to GamesTable's payloads (admin run games and released-season matchup tables), so plain
 *  ids are fine; undefined when no seat is a submission (an all-Naive game). */
function playersTitle(seats: BoardAgentRef[]): string | undefined {
  const ids = seats.filter((seat) => seat.kind === 'submission').map((seat) => seat.user_id)
  return ids.length > 0 ? ids.join(' · ') : undefined
}
</script>

<template>
  <table class="games-table">
    <thead>
      <tr>
        <th scope="col">Game</th>
        <th scope="col">Players</th>
        <th scope="col">Status</th>
        <th scope="col">Replay</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="game in games" :key="game.id" data-testid="game-row">
        <td class="game-id">m{{ game.match_index }} · g{{ game.game_index }} · seed {{ game.seed }}</td>
        <td :title="playersTitle(game.seats)">{{ playersSummary(game.seats) }}</td>
        <td>
          <UiStatusBadge
            :tone="STATUS_TONE[gameStatus(game.game_index, game.status)]"
            :label="gameStatus(game.game_index, game.status)"
          />
        </td>
        <td>
          <RouterLink
            v-if="game.recording_id !== null"
            class="replay-link"
            :to="`/replays/${game.recording_id}`"
          >
            Replay
          </RouterLink>
          <span v-else class="muted">—</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.games-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.games-table th,
.games-table td {
  text-align: left;
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.games-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.game-id {
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.replay-link {
  color: var(--color-accent);
  text-decoration: none;
}

.replay-link:hover {
  text-decoration: underline;
}

.muted {
  color: var(--color-text-muted);
}
</style>
