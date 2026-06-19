<!--
  Documentation: the in-app home for the student guides (getting started, submitting, the agent
  interface). For now it is a quiet "coming soon" placeholder so the sidebar entry is a real
  destination rather than a dead link; the guides themselves land here in a later pass.
-->
<script setup lang="ts">
import UiEmptyState from '../components/ui/UiEmptyState.vue'
</script>

<template>
  <section class="docs">
    <header class="docs-intro">
      <h1>Documentation</h1>
      <p class="docs-lede">Guides for writing, testing, and submitting your agent.</p>
    </header>
    <UiEmptyState>Documentation is coming soon.</UiEmptyState>
  </section>
</template>

<style scoped>
.docs-intro {
  margin-bottom: var(--space-5);
}

.docs-intro h1 {
  margin: 0 0 var(--space-1);
}

.docs-lede {
  margin: 0;
  color: var(--color-text-muted);
}
</style>
