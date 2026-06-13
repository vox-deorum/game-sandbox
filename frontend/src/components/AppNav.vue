<!--
  The primary section nav in the app shell's top bar (see plans/stage-04.5/information-architecture.md).
  Environments is live today; Agents and Leaderboards are visible coming-soon placeholders — inert
  text with a `soon` tag, not links and not focusable — so the product's eventual shape is legible
  without dead-end links. Stage 5 turns Agents into a real link; Stage 6 does the same for
  Leaderboards. On narrow screens the placeholders collapse first because they carry no function yet.
-->
<script setup lang="ts">
import { RouterLink } from 'vue-router'

// Sections that have no destination yet. When a stage lands its section, it moves up to a RouterLink.
const placeholders = ['Agents', 'Leaderboards']
</script>

<template>
  <nav class="app-nav" aria-label="Primary">
    <RouterLink class="nav-link" to="/">Environments</RouterLink>
    <span v-for="label in placeholders" :key="label" class="nav-placeholder">
      {{ label }}
      <span class="nav-soon">soon</span>
    </span>
  </nav>
</template>

<style scoped>
.app-nav {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-width: 0;
}

.nav-link {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  transition: color var(--motion-fast) var(--ease-out);
}

.nav-link:hover {
  color: var(--color-text);
}

.nav-link.router-link-active {
  color: var(--color-text);
  font-weight: 600;
}

/* Inert by construction: no href, no tabindex, default cursor — it reads as "not yet here". */
.nav-placeholder {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  opacity: 0.55;
  cursor: default;
  white-space: nowrap;
}

.nav-soon {
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
}

/* The placeholders carry no function yet, so they are the first thing to drop on a narrow bar. */
@media (max-width: 480px) {
  .nav-placeholder {
    display: none;
  }
}
</style>
