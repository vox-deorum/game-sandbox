<!--
  The Leaderboards page (Stage 6.7): the per-environment, per-season full-width stacked board view,
  the spec's "Leaderboards" page. It is linkable by URL with the season id, so a specific released
  season's boards are shareable; with no season id it defaults to the environment's current
  released season. The environment page embeds the current boards and links here for history.

  Every read here hits the public, released-only routes, so an unreleased season's boards never
  appear: an unknown or unreleased season id resolves to a not-found message, never a board (an
  operator may still preview one through the operator-only admin read). The history rail lists the
  released seasons newest-first and highlights the one in view; an operator additionally sees the
  environment's unreleased seasons there.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  type Board,
  getAdminSeason,
  getEnvironmentLeaderboards,
  getSeasonLeaderboards,
  listSeasons,
  type PublicSeasonView,
  type SeasonView,
} from '../api/client.js'
import LeaderboardBoards from '../components/LeaderboardBoards.vue'
import UiBadge from '../components/ui/UiBadge.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { useEnvironmentMeta } from '../composables/useEnvironmentMeta.js'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'

const route = useRoute()
const me = useMe()
const envId = String(route.params.envId)
const { meta } = useEnvironmentMeta(envId)

const loading = ref(true)
const notReleased = ref(false)
const failed = ref(false)
const board = ref<Board | null>(null)
const season = ref<SeasonView | null>(null)
// The seasons listed in the Seasons table, newest first, with their activity counts; also backs the
// header annotation for the season in view (matched out of this same list by id). Released-only for
// the public, but every season (including unreleased ones) for an operator.
const history = ref<PublicSeasonView[]>([])
// True when the board shown is an unreleased season surfaced through the operator-only admin read,
// so the page can flag it as not yet public. Only ever set for an operator viewing a specific season.
const operatorPreview = ref(false)

/** The season id in the URL, or undefined to default to the current released season. */
const requestedSeasonId = computed(() => {
  const raw = route.params.seasonId
  return typeof raw === 'string' && raw !== '' ? raw : undefined
})

function seasonLabel(view: { id: string; label: string | null }): string {
  return view.label ?? `Season ${view.id.slice(0, 8)}`
}

/** The activity counts for the season in view, looked up in the released history (absent for an
 * operator-only unreleased preview, which never appears in the public list). */
const currentCounts = computed(() =>
  season.value === null ? undefined : history.value.find((entry) => entry.id === season.value?.id),
)

async function load(): Promise<void> {
  loading.value = true
  notReleased.value = false
  failed.value = false
  board.value = null
  season.value = null
  operatorPreview.value = false
  try {
    // Operators see every season for the environment — including unreleased and fully-private ones —
    // so the history rail doubles as their season index; everyone else sees the released seasons only.
    await me.whenSettled()
    history.value = me.me?.is_operator
      ? await listSeasons(envId, { includeUnreleased: true })
      : (await listSeasons(envId)).filter((entry) => entry.release_status === 'released')
    if (requestedSeasonId.value !== undefined) {
      const result = await getSeasonLeaderboards(envId, requestedSeasonId.value)
      if (result === undefined) {
        await loadOperatorPreview(requestedSeasonId.value)
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

// The public read 404s for an unreleased season. An operator may still preview it before release, so
// fall back to the operator-only admin read; a non-operator (or any failure) keeps the not-released
// message. The admin board is the same shape the public read returns, so the rendering is unchanged.
async function loadOperatorPreview(seasonId: string): Promise<void> {
  await me.whenSettled()
  if (!me.me?.is_operator) {
    notReleased.value = true
    return
  }
  try {
    const view = await getAdminSeason(seasonId)
    if (view.season.env_id !== envId) {
      notReleased.value = true
      return
    }
    season.value = view.season
    board.value = view.board
    operatorPreview.value = true
  } catch {
    notReleased.value = true
  }
}

// Re-resolve when the season id in the URL changes, so the history links navigate in place.
watch(requestedSeasonId, load, { immediate: true })
</script>

<template>
  <section class="leaderboards">
    <header class="leaderboards-header">
      <h1>Leaderboards</h1>
      <h2 v-if="season !== null" class="leaderboards-sub">
        Season: {{ seasonLabel(season) }}
        <UiBadge v-if="operatorPreview" variant="accent">Operator preview · unreleased</UiBadge>
        <span v-else-if="season.released_at !== null" class="leaderboards-released">
          · released {{ formatDate(season.released_at) }}
        </span>
        <template v-if="currentCounts !== undefined">
          <UiBadge class="leaderboards-stat">{{ currentCounts.submission_count }} submissions</UiBadge>
          <UiBadge class="leaderboards-stat">{{ currentCounts.session_count }} games run</UiBadge>
        </template>
      </h2>
    </header>

    <main class="leaderboards-main">
      <UiEmptyState v-if="loading">Loading…</UiEmptyState>
      <UiEmptyState v-else-if="failed" tone="danger">Could not load the leaderboards.</UiEmptyState>
      <UiEmptyState v-else-if="notReleased">
        No released results for this season yet.
      </UiEmptyState>
      <LeaderboardBoards
        v-else-if="board !== null"
        :board="board"
        :env-id="envId"
        :rating-prompt="season?.rating_prompt ?? null"
      />
    </main>

    <section v-if="history.length > 0" class="leaderboards-history" aria-label="Seasons">
      <h2 class="history-title">All Seasons</h2>
      <table class="history-table">
        <thead>
          <tr>
            <th scope="col">Season</th>
            <th scope="col">Released</th>
            <th scope="col" class="num"># Submissions</th>
            <th scope="col" class="num"># Games Run</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in history" :key="entry.id" :class="{ current: entry.id === season?.id }">
            <td>
              <RouterLink
                class="history-link"
                :to="`/environments/${envId}/leaderboards/${entry.id}`"
              >
                {{ seasonLabel(entry) }}
              </RouterLink>
            </td>
            <td>{{ entry.released_at !== null ? formatDate(entry.released_at) : '—' }}</td>
            <td class="num">{{ entry.submission_count }}</td>
            <td class="num">{{ entry.session_count }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<style scoped>
.leaderboards-header h1 {
  margin: 0;
}

.leaderboards-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.leaderboards-stat {
  font-weight: 500;
}

.leaderboards-history {
  margin-top: var(--space-8);
}

.history-title {
  margin: 0 0 var(--space-3);
}

.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.history-table th,
.history-table td {
  text-align: left;
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.history-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.history-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* The season in view stands out as the anchor row of the table. */
.history-table tr.current td {
  font-weight: 600;
}

.history-link {
  color: var(--color-text-muted);
  transition: color var(--motion-fast) var(--ease-out);
}

.history-link:hover {
  color: var(--color-text);
}

.history-table tr.current .history-link {
  color: var(--color-text);
}
</style>
