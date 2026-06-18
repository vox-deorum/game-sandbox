<!--
  The primary section nav in the app shell's top bar (see plans/stage-04.5/information-architecture.md).
  Environments and Leaderboards are live. Leaderboards follows the current environment when the
  route names one; elsewhere it returns to the environment gallery so the user can choose which
  environment's boards to open. Agents remains an inert coming-soon placeholder.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

const route = useRoute()

const leaderboardsTo = computed(() => {
  const envId = route.params.envId
  return typeof envId === 'string' && envId !== ''
    ? `/environments/${envId}/leaderboards`
    : '/'
})
</script>

<template>
  <nav class="app-nav" aria-label="Primary">
    <RouterLink class="nav-link" to="/">Environments</RouterLink>
    <span class="nav-placeholder">
      Agents
      <span class="nav-soon">soon</span>
    </span>
    <RouterLink class="nav-link" :to="leaderboardsTo">Leaderboards</RouterLink>
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

/* The remaining placeholder carries no function, so it is the first thing to drop on a narrow bar. */
@media (max-width: 480px) {
  .nav-placeholder {
    display: none;
  }
}
</style>
