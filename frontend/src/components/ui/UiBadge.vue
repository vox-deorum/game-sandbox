<!--
  The badge primitive: a small text-bearing tag. Badges always carry text, never a bare glyph or a
  color-only dot, so the meaning survives without color (the accessibility baseline). Use
  UiStatusBadge for live status with its paired dot.
-->
<script setup lang="ts">
withDefaults(
  defineProps<{ variant?: 'neutral' | 'accent' | 'warning' | 'danger' }>(),
  { variant: 'neutral' },
)
</script>

<template>
  <span class="ui-badge" :class="variant"><slot /></span>
</template>

<style scoped>
.ui-badge {
  display: inline-block;
  font-size: var(--text-xs);
  font-weight: 600;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text);
  white-space: nowrap;
}

.ui-badge.accent {
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.ui-badge.warning {
  background: var(--color-warning);
  color: var(--color-bg);
}

.ui-badge.danger {
  background: var(--color-danger);
  color: var(--color-bg);
}
</style>
