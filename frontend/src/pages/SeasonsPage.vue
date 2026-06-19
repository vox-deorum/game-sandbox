<!--
  Seasons: the cross-game competition view — "what is open right now, and what was last released."
  It answers the student's first question ("what should I work on?") without first picking a game.

  Phase 1 builds this by aggregating the public per-game leaderboards read across every environment
  (submission and play windows, plus the current released season). A later pass replaces the fan-out
  with a single backing endpoint; the page shape stays the same.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { type EnvironmentLeaderboards, getEnvironmentLeaderboards, getEnvironments } from '../api/client.js'
import UiBadge from '../components/ui/UiBadge.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'

interface EnvironmentSeasons {
  meta: EnvironmentMeta
  leaderboards: EnvironmentLeaderboards | null
}

const rows = ref<EnvironmentSeasons[] | null>(null)
const error = ref(false)

onMounted(async () => {
  try {
    const envs = await getEnvironments()
    rows.value = await Promise.all(
      envs.map(async (meta) => ({
        meta,
        leaderboards: await getEnvironmentLeaderboards(meta.env_id).catch(() => null),
      })),
    )
  } catch {
    error.value = true
  }
})

function isOpen(row: EnvironmentSeasons): boolean {
  return (
    row.leaderboards?.submission_season_id != null || row.leaderboards?.play_season_id != null
  )
}

/** Open games first, so the live competitions lead. */
const ordered = computed(() =>
  rows.value === null
    ? []
    : [...rows.value].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a))),
)

function currentSeasonLabel(row: EnvironmentSeasons): string | null {
  const current = row.leaderboards?.current
  if (current == null) {
    return null
  }
  return current.season.label ?? `Season ${current.season.id.slice(0, 8)}`
}
</script>

<template>
  <section class="seasons">
    <header class="seasons-intro">
      <h1>Seasons</h1>
      <p class="seasons-lede">Where the action is — open submissions and play across every environment.</p>
    </header>

    <UiEmptyState v-if="error" tone="danger">Could not load seasons.</UiEmptyState>
    <UiEmptyState v-else-if="rows === null">Loading…</UiEmptyState>
    <UiEmptyState v-else-if="rows.length === 0">No environments yet.</UiEmptyState>
    <ul v-else class="season-list">
      <li v-for="row in ordered" :key="row.meta.env_id">
        <UiCard>
          <div class="season-head">
            <RouterLink class="season-game" :to="`/environments/${row.meta.env_id}`">
              {{ row.meta.display_name }}
            </RouterLink>
            <UiBadge v-if="isOpen(row)" variant="accent">Open now</UiBadge>
          </div>
          <div class="season-status">
            <UiBadge v-if="row.leaderboards?.submission_season_id != null">Submissions open</UiBadge>
            <UiBadge v-if="row.leaderboards?.play_season_id != null">Play open</UiBadge>
            <span v-if="currentSeasonLabel(row) !== null" class="season-current">
              Latest released: {{ currentSeasonLabel(row) }}
            </span>
            <span v-else class="season-current muted">No released results yet</span>
          </div>
          <RouterLink class="season-link" :to="`/environments/${row.meta.env_id}/leaderboards`">
            View leaderboard →
          </RouterLink>
        </UiCard>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.seasons-intro {
  margin-bottom: var(--space-5);
}

.seasons-intro h1 {
  margin: 0 0 var(--space-1);
}

.seasons-lede {
  margin: 0;
  color: var(--color-text-muted);
}

.season-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.season-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.season-game {
  font-size: var(--text-lg);
  font-weight: 600;
}

.season-game:hover {
  color: var(--color-accent);
}

.season-status {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
}

.season-current {
  color: var(--color-text-muted);
}

.season-current.muted {
  font-style: italic;
}

.season-link {
  color: var(--color-accent);
  font-size: var(--text-sm);
}
</style>
