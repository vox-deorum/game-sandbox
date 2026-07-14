<!--
  The cross-environment game-over screen: a ranked leaderboard shown over the final frame when a
  match ends, in both live sessions and replays. It is host chrome, not renderer-specific, so every
  environment gets the same screen; the Python twin is scripts/play.py `_show_game_over`.

  Rows are ranked best-first from the terminal step state (see lib/standings.ts): the top three get
  gold/silver/bronze cups and each row shows the game's natural score. The list is bounded by a top
  and bottom rule only (no box). Dismissable: a click on the backdrop or the Close button hides it.
-->
<script setup lang="ts">
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import { Trophy } from '@lucide/vue'
import { computed } from 'vue'

import UiButton from './ui/UiButton.vue'
import { formatSlotIndex } from '../lib/format.js'
import { buildStandings } from '../lib/standings.js'

const props = withDefaults(
  defineProps<{
    state: StepState
    header: RecordingHeader | null
    /** Hide submitted-agent ownership while a non-operator views a playable season. */
    blind?: boolean
    /** Lets a blind viewer still recognize their own submitted agent. */
    viewerId?: string
    /** Submission id → season-wide anonymous number, matching the attribution line and rating panel. */
    anonymousNumbers?: Record<string, number>
  }>(),
  { blind: false, viewerId: undefined, anonymousNumbers: undefined },
)

const emit = defineEmits<{ dismiss: [] }>()

// The labels honour the same blind policy as the per-slot attribution line, via the shared helper.
const standings = computed(() =>
  buildStandings(props.state, props.header, {
    blind: props.blind,
    viewerId: props.viewerId,
    anonymousNumbers: props.anonymousNumbers,
  }),
)

/**
 * The card is a non-modal overlay over the final frame, not a focus-trapping modal: the board beneath
 * stays inspectable, and on the replay page the stage owns transport keys. So keep keystrokes from
 * bubbling out to that transport (Space would restart playback instead of pressing Close), and let
 * Escape dismiss when focus is within the card.
 */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation()
  if (event.key === 'Escape') {
    emit('dismiss')
  }
}

</script>

<template>
  <div
    class="game-over"
    role="dialog"
    aria-label="Game over"
    @click.self="emit('dismiss')"
    @keydown="onKeydown"
  >
    <div class="card">
      <h2 class="title">Game over</h2>
      <ol class="board">
        <li
          v-for="row in standings"
          :key="row.slot"
          class="row"
          :class="{ podium: row.medal !== null }"
        >
          <span class="cup" :class="row.medal" aria-hidden="true">
            <Trophy v-if="row.medal !== null" :size="20" />
          </span>
          <span class="seat">P{{ formatSlotIndex(row.slot) }}</span>
          <span class="who">{{ row.label }}</span>
          <span class="value">{{ row.value }}</span>
        </li>
      </ol>
      <UiButton variant="secondary" size="tight" @click="emit('dismiss')">Close</UiButton>
    </div>
  </div>
</template>

<style scoped>
.game-over {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* The dimmed backdrop over the final frame (the same scrim the paused/waiting banners use). */
  background: var(--color-scrim);
  /* Above the canvas and the paused/waiting banners. */
  z-index: 2;
  padding: var(--space-4);
}

.card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  width: min(360px, 90%);
}

.title {
  margin: 0;
  font-family: var(--font-heading);
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--color-text);
}

.board {
  list-style: none;
  margin: 0;
  padding: var(--space-2) 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  /* The leaderboard "table": top and bottom rules only, no surrounding box. */
  border-top: 1px solid var(--color-border-strong);
  border-bottom: 1px solid var(--color-border-strong);
}

.row {
  display: grid;
  grid-template-columns: 1.75rem auto 1fr auto;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-md);
  color: var(--color-text-muted);
}

/* The seat tag (P0…P3) disambiguates rows when several seats share one agent name; it stays a
   compact, muted secondary read so the agent name remains primary. */
.seat {
  color: var(--color-text-muted);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* Podium finishers read at full strength; the rest sit muted. */
.row.podium {
  color: var(--color-text);
}

.cup {
  display: inline-flex;
  justify-content: center;
}

.cup.gold {
  color: var(--color-medal-gold);
}

.cup.silver {
  color: var(--color-medal-silver);
}

.cup.bronze {
  color: var(--color-medal-bronze);
}

.who {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.value {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
</style>
