<!--
  The one-line cause under an "Ended unexpectedly" status badge, naming what raised and where, for
  example "P3's agent raised KeyError: 'evening' (agent.py:88 in assign)". The live session page, local
  play, and the replay viewer all place it below their status bar behind their own `v-if`.
-->
<script setup lang="ts">
defineProps<{ text: string }>()
</script>

<template>
  <p class="run-end-cause">{{ text }}</p>
</template>

<style scoped>
.run-end-cause {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
</style>
