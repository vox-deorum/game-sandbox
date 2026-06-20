<!--
  The Leaderboards page (Stage 6.7): the per-environment, per-season full side-by-side board view,
  the spec's "Leaderboards" page. It is linkable by URL with the season id, so a specific released
  season's boards are shareable; with no season id it defaults to the environment's current
  released season. The environment page embeds the current boards and links here for history.

  Every read here hits the public, released-only routes, so an unreleased season's boards never
  appear: an unknown or unreleased season id resolves to a not-found message, never a board. The
  history rail lists the released seasons newest-first and highlights the one in view.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  type Board,
  getEnvironmentLeaderboards,
  getSeasonLeaderboards,
  type SeasonView,
  listReleasedSeasons,
} from '../api/client.js'
import LeaderboardBoards from '../components/LeaderboardBoards.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { useEnvironmentMeta } from '../composables/useEnvironmentMeta.js'
import { formatDate } from '../lib/format.js'

const route = useRoute()
const envId = String(route.params.envId)
const { meta } = useEnvironmentMeta(envId)

const loading = ref(true)
const notReleased = ref(false)
const failed = ref(false)
const board = ref<Board | null>(null)
const season = ref<SeasonView | null>(null)
const history = ref<SeasonView[]>([])

/** The season id in the URL, or undefined to default to the current released season. */
const requestedSeasonId = computed(() => {
  const raw = route.params.seasonId
  return typeof raw === 'string' && raw !== '' ? raw : undefined
})

function seasonLabel(view: SeasonView): string {
  return view.label ?? `Season ${view.id.slice(0, 8)}`
}

async function load(): Promise<void> {
  loading.value = true
  notReleased.value = false
  failed.value = false
  board.value = null
  season.value = null
  try {
    history.value = await listReleasedSeasons(envId)
    if (requestedSeasonId.value !== undefined) {
      const result = await getSeasonLeaderboards(envId, requestedSeasonId.value)
      if (result === undefined) {
        notReleased.value = true
      } else {
        season.value = result.season
        board.value = result.board
      }
    } else {
      const result = await getEnvironmentLeaderboards(envId)
      if (result.current === null) {
        notReleased.value = true
      } else {
        season.value = result.current.season
        board.value = result.current.board
      }
    }
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

// Re-resolve when the season id in the URL changes, so the history links navigate in place.
watch(requestedSeasonId, load, { immediate: true })
</script>

<template>
  <section class="leaderboards">
    <header class="leaderboards-header">
      <h1>Leaderboards</h1>
      <p v-if="season !== null" class="leaderboards-sub">
        {{ seasonLabel(season) }}
        <span v-if="season.released_at !== null" class="leaderboards-released">
          · released {{ formatDate(season.released_at) }}
        </span>
      </p>
    </header>

    <div class="leaderboards-body">
      <main class="leaderboards-main">
        <UiEmptyState v-if="loading">Loading…</UiEmptyState>
        <UiEmptyState v-else-if="failed" tone="danger">Could not load the leaderboards.</UiEmptyState>
        <UiEmptyState v-else-if="notReleased">
          No released results for this season yet.
        </UiEmptyState>
        <LeaderboardBoards v-else-if="board !== null" :board="board" :env-id="envId" />
      </main>

      <aside v-if="history.length > 0" class="leaderboards-history" aria-label="Released seasons">
        <h2 class="history-title">Seasons</h2>
        <ul class="history-list">
          <li v-for="entry in history" :key="entry.id">
            <RouterLink
              class="history-link"
              :class="{ current: entry.id === season?.id }"
              :to="`/environments/${envId}/leaderboards/${entry.id}`"
            >
              {{ seasonLabel(entry) }}
            </RouterLink>
          </li>
        </ul>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.leaderboards-header h1 {
  margin: 0 0 var(--space-1);
}

.leaderboards-sub {
  margin: 0 0 var(--space-5);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.leaderboards-body {
  display: grid;
  grid-template-columns: 1fr 14rem;
  gap: var(--space-6);
  align-items: start;
}

.history-title {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.history-link {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  transition: color var(--motion-fast) var(--ease-out);
}

.history-link:hover {
  color: var(--color-text);
}

.history-link.current {
  color: var(--color-text);
  font-weight: 600;
}

@media (max-width: 768px) {
  .leaderboards-body {
    grid-template-columns: 1fr;
  }
}
</style>
