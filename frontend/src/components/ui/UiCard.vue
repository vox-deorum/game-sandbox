<!--
  The card primitive: a bordered surface. It is only the surface (background, border, radius,
  optional padding); layout inside is the caller's. The info variant gives short guidance and
  summaries a stronger border and background. `interactive` adds the hover affordance for cards
  that are links, like the home gallery cards.
-->
<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'default' | 'info'
    /** Skip the default padding when the content manages its own (e.g. an edge-to-edge thumbnail). */
    padded?: boolean
    /** Hover affordance for cards that act as a single link. */
    interactive?: boolean
  }>(),
  { variant: 'default', padded: true, interactive: false },
)
</script>

<template>
  <div class="ui-card" :class="[variant, { padded, interactive }]">
    <slot />
  </div>
</template>

<style scoped>
.ui-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.ui-card.padded {
  padding: var(--space-4);
}

.ui-card.info {
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-4);
  background: var(--color-surface-raised);
  border-color: var(--color-border-strong);
}

.ui-card.interactive {
  transition: border-color var(--motion-fast) var(--ease-out);
}

.ui-card.interactive:hover {
  border-color: var(--color-accent);
}
</style>
