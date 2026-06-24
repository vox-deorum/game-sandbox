<!--
  One run's scheduled games as a table, on the run-details page. Each row identifies the game
  (m{match}·g{game}·seed), names the agents in its seats, shows its status — the live overlay while the
  run streams, else the persisted status — and links to the game's replay once a recording exists. A
  game with no recording yet (still pending/running, or a failure that produced none) shows an em dash.
-->
<script setup lang="ts">
import { RouterLink } from 'vue-router'

import type { BoardAgentRef, GameStatus, RunGameView } from '../../api/client.js'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

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

/** A seat's agent label: the owner for a submission, "Naive" for the builtin baseline. */
function slotLabel(slot: BoardAgentRef): string {
  return slot.kind === 'submission' ? slot.user_id : 'Naive'
}

/** A compact one-line summary of the agents in a game's seats, in seat order. */
function playersSummary(slots: BoardAgentRef[]): string {
  return slots.length === 0 ? '—' : slots.map(slotLabel).join(' · ')
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
        <td>{{ playersSummary(game.slots) }}</td>
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
