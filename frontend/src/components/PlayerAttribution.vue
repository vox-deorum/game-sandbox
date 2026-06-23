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

const props = withDefaults(
  defineProps<{
    players?: RecordingHeader['players']
    /** Hide submitted-agent ownership while a non-operator views a playable season. */
    blind?: boolean
    /** Lets a blind viewer still recognize their own submitted agent. */
    viewerId?: string
    /**
     * Submission id → season-wide anonymous number, so a blind submitted agent reads with the same
     * "Submitted agent N" label the watch picker and rating panel use for that agent. A missing
     * number degrades to the bare label, matching the rating route's own fallback for an agent no
     * longer in the active list.
     */
    anonymousNumbers?: Record<string, number>
  }>(),
  { players: undefined, blind: false, viewerId: undefined, anonymousNumbers: undefined },
)

/** A blind submitted agent's label, numbered to match the watch picker and rating panel. */
function blindAgentLabel(submissionId: string): string {
  const number = props.anonymousNumbers?.[submissionId]
  return number === undefined ? 'Submitted agent' : `Submitted agent ${number}`
}

const items = computed(() => {
  const players = props.players
  if (players === undefined) {
    return []
  }
  return Object.entries(players).map(([slot, player]) => ({
    slot,
    text:
      player.kind === 'human'
        ? `Human: ${player.user ?? player.label}`
        : props.blind && player.submission_id !== undefined
          ? player.user === props.viewerId
            ? 'Your agent'
            : blindAgentLabel(player.submission_id)
          : player.label,
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
