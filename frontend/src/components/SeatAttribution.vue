<!--
  The replay's per-seat attribution line. The seat is the scored assignment, while the player members
  stay available from the seat label's tooltip. Older recordings that lack either header map show no
  attribution line.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { computed } from 'vue'

import { seatControllerLabel, seatControllerTitle } from '../lib/attribution.js'
import { formatPlayer, formatSeat } from '../lib/format.js'
import UiTooltip from './ui/UiTooltip.vue'

const props = withDefaults(
  defineProps<{
    players?: RecordingHeader['players']
    seats?: RecordingHeader['seats']
    /** Hide submitted-agent ownership while a non-operator views a playable season. */
    blind?: boolean
    /** Lets a blind viewer still recognize their own submitted agent. */
    viewerId?: string
    /** Submission id → season-wide anonymous number, matching the watch picker and rating panel. */
    anonymousNumbers?: Record<string, number>
  }>(),
  {
    players: undefined,
    seats: undefined,
    blind: false,
    viewerId: undefined,
    anonymousNumbers: undefined,
  },
)

const items = computed(() => {
  if (props.players === undefined || props.seats === undefined) return []
  const ctx = {
    blind: props.blind,
    viewerId: props.viewerId,
    anonymousNumbers: props.anonymousNumbers,
  }
  return Object.entries(props.seats)
    .sort(([a], [b]) => Number(a.slice('seat_'.length)) - Number(b.slice('seat_'.length)))
    .map(([seatId, members]) => ({
      seatId,
      seat: formatSeat(seatId),
      members: members.map(formatPlayer).join(', '),
      label: seatControllerLabel(members, props.players, ctx),
      title: seatControllerTitle(members, props.players, ctx),
    }))
})
</script>

<template>
  <ul v-if="items.length > 0" class="seats">
    <li v-for="item in items" :key="item.seatId" class="seat">
      <UiTooltip :label="item.seat" :accessible-label="`Show players assigned to ${item.seat}`">
        <template #content>Players: {{ item.members }}</template>
      </UiTooltip>
      <span class="seat-controller" :title="item.title">{{ item.label }}</span>
    </li>
  </ul>
</template>

<style scoped>
.seats {
  list-style: none;
  margin: 0 0 var(--space-3);
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.seat {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.seat-controller {
  color: var(--color-text);
}
</style>
