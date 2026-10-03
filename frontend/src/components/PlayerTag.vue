<!--
  A compact player id ("P7") wherever the host chrome names a player: chat rows, decision rows, and
  the replay thread. When the mounted renderer reports an in-game name for the player, the id becomes a
  tooltip trigger that shows that name, and hovering or focusing it asks the renderer to highlight the
  player's figure. Without a name it is plain text, exactly as before.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'

import { usePlayerIdentity } from '../composables/usePlayerIdentity.js'
import { formatPlayer } from '../lib/format.js'
import UiTooltip from './ui/UiTooltip.vue'

const props = defineProps<{
  /** The stable player id; empty reads "None", as a decision log row with no single actor does. */
  playerId: string
}>()

const identity = usePlayerIdentity()
const label = computed(() => (props.playerId === '' ? 'None' : formatPlayer(props.playerId)))
const name = computed(() =>
  props.playerId === '' ? undefined : identity.profiles.value[props.playerId]?.name,
)

// Hover and keyboard focus each hold the highlight, so the pointer leaving a focused tag keeps it. The
// tag itself is the request's source, which lets the page share one highlight among all its tags.
const source = {}
let hovered = false
let focused = false

function sync(): void {
  identity.highlight(source, (hovered || focused) && name.value !== undefined ? props.playerId : null)
}

function setHovered(value: boolean): void {
  hovered = value
  sync()
}

function setFocused(value: boolean): void {
  focused = value
  sync()
}

onBeforeUnmount(() => identity.highlight(source, null))
</script>

<template>
  <span
    class="player-tag"
    @mouseenter="setHovered(true)"
    @mouseleave="setHovered(false)"
    @focusin="setFocused(true)"
    @focusout="setFocused(false)"
  >
    <UiTooltip v-if="name !== undefined" :label="label" :accessible-label="`${label}, ${name}`">
      <template #content>{{ name }}</template>
    </UiTooltip>
    <template v-else>{{ label }}</template>
  </span>
</template>
