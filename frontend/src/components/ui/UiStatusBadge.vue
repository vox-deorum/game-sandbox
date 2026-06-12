<!--
  The status indicator primitive: a colored dot always paired with a text label, so status is never
  conveyed by color alone (the accessibility baseline). The tone colors the dot; the label carries
  the meaning. Replaces the Stage 4 .status-dot pattern.
-->
<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string
    tone?: 'neutral' | 'success' | 'danger' | 'warning'
  }>(),
  { tone: 'neutral' },
)
</script>

<template>
  <span class="ui-status-badge">
    <span class="dot" :class="tone" aria-hidden="true" />
    <span class="label">{{ label }}</span>
  </span>
</template>

<style scoped>
.ui-status-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}

.dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: var(--radius-full);
  background: var(--color-text-muted);
}

.dot.success {
  background: var(--color-success);
}

.dot.danger {
  background: var(--color-danger);
}

.dot.warning {
  background: var(--color-warning);
}

.label {
  font-size: var(--text-sm);
}
</style>
