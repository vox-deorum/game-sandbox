<!--
  The per-slot attribution line: who or what played each slot, read from the recording header's
  `players` map. A human slot names the user; an agent slot shows its label (the Naive agent, or a
  submission owner's agent). Older recordings have no `players` block, so this renders nothing,
  the same tolerate-absence rule the header's other optional fields follow.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { computed } from 'vue'

import { attributionLabel, isBlindMasked } from '../lib/attribution.js'
import { formatPlayer } from '../lib/format.js'

const props = withDefaults(
  defineProps<{
    players?: RecordingHeader['players']
    /** Hide submitted-agent ownership while a non-operator views a playable season. */
    blind?: boolean
    /** Lets a blind viewer still recognize their own submitted agent. */
    viewerId?: string
    /**
     * Submission id → season-wide anonymous number, so a blind submitted agent reads with the same
     * "Agent N" label the watch picker and rating panel use for that agent. A missing
     * number degrades to the bare label, matching the rating route's own fallback for an agent no
     * longer in the active list.
     */
    anonymousNumbers?: Record<string, number>
  }>(),
  { players: undefined, blind: false, viewerId: undefined, anonymousNumbers: undefined },
)

// The shared attribution helper (also used by the end-of-game leaderboard) owns the blind policy and
// the labels; this line keeps the "Human:" affordance that marks a human slot here.
const items = computed(() => {
  const players = props.players
  if (players === undefined) {
    return []
  }
  const ctx = {
    blind: props.blind,
    viewerId: props.viewerId,
    anonymousNumbers: props.anonymousNumbers,
  }
  return Object.entries(players).map(([slot, player]) => {
    const label = attributionLabel(slot, player, ctx)
    const masked = isBlindMasked(player, ctx)
    // The stable id rides as a tooltip whenever this row's identity isn't blind-masked — on either
    // kind now, not just human. A masked row (someone else's identity hidden while the season plays)
    // gets no title at all; the viewer's own row (never masked) keeps it.
    const title = masked ? undefined : player.user
    // A masked human row already reads as the bare neutral "Human" (attributionLabel's blind branch),
    // so adding the "Human:" prefix here would double up into "Human: Human" — only add it once the
    // real name is showing.
    const text = player.kind === 'human' && !masked ? `Human: ${label}` : label
    return { slot, text, title }
  })
})
</script>

<template>
  <ul v-if="items.length > 0" class="players">
    <li v-for="item in items" :key="item.slot" class="player">
      <span class="player-slot">{{ formatPlayer(item.slot) }}</span>
      <span class="player-who" :title="item.title">{{ item.text }}</span>
    </li>
  </ul>
</template>

<style scoped>
.players {
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.player {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.player-slot {
  color: var(--color-text-muted);
}

.player-who {
  color: var(--color-text);
}
</style>
