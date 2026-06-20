<!--
  The per-slot attribution line: who or what played each slot, read from the recording header's
  `players` map. A human slot names the user; an agent slot shows its label (the Naive agent, or a
  submission owner's agent). Older recordings have no `players` block, so this renders nothing,
  the same tolerate-absence rule the header's other optional fields follow.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { computed } from 'vue'

import { formatSlot } from '../lib/format.js'

const props = defineProps<{ players?: RecordingHeader['players'] }>()

const items = computed(() => {
  const players = props.players
  if (players === undefined) {
    return []
  }
  return Object.entries(players).map(([slot, player]) => ({
    slot,
    text: player.kind === 'human' ? `Human: ${player.user ?? player.label}` : player.label,
  }))
})
</script>

<template>
  <ul v-if="items.length > 0" class="players">
    <li v-for="item in items" :key="item.slot" class="player">
      <span class="player-slot">{{ formatSlot(item.slot) }}</span>
      <span class="player-who">{{ item.text }}</span>
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
