<!--
  The loading, empty, and error message primitive: one consistent presentation for the in-between
  page states that Stage 4 styled as ad hoc .status and .error paragraphs. The tone is muted for
  loading and empty, danger for errors; the message is the slot.
-->
<script setup lang="ts">
withDefaults(defineProps<{ tone?: 'muted' | 'danger' }>(), { tone: 'muted' })
</script>

<template>
  <p class="ui-empty-state" :class="tone"><slot /></p>
</template>

<style scoped>
.ui-empty-state {
  font-size: var(--text-sm);
}

.ui-empty-state.muted {
  color: var(--color-text-muted);
}

.ui-empty-state.danger {
  color: var(--color-danger);
}
</style>
