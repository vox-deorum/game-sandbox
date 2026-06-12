<!--
  The card primitive: a bordered surface. It is only the surface (background, border, radius,
  optional padding); layout inside is the caller's. `interactive` adds the hover affordance for
  cards that are links, like the home gallery cards.
-->
<script setup lang="ts">
withDefaults(
  defineProps<{
    /** Skip the default padding when the content manages its own (e.g. an edge-to-edge thumbnail). */
    padded?: boolean
    /** Hover affordance for cards that act as a single link. */
    interactive?: boolean
  }>(),
  { padded: true, interactive: false },
)
</script>

<template>
  <div class="ui-card" :class="{ padded, interactive }">
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
  padding: var(--space-4) var(--space-5);
}

.ui-card.interactive {
  transition: border-color var(--motion-fast) var(--ease-out);
}

.ui-card.interactive:hover {
  border-color: var(--color-accent);
}
</style>
