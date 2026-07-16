<!--
  My Agents is the signed-in student's compact cross-environment season index. Each environment has
  one flat list with the current season first, followed by recent seasons. Every row is one link to
  that season in My Submissions.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { Clock } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import {
  getMyAgents,
  type MyAgentEnvironmentSummary,
  type MyAgentSeasonSummary,
} from '../api/client.js'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { loadEnvironmentCatalog } from '../environmentCatalog.js'
import { formatDate, formatScore } from '../lib/format.js'
import { submissionStatusLabel, submissionStatusTone } from '../lib/submission-status.js'
import { useMe, userId } from '../me.js'

interface EnvironmentAgent {
  summary: MyAgentEnvironmentSummary
  meta: EnvironmentMeta | null
}

interface SeasonRow {
  season: MyAgentSeasonSummary
  isCurrent: boolean
}

const me = useMe()
const ownerId = ref<string | null>(null)
const rows = ref<EnvironmentAgent[] | null>(null)
const error = ref(false)
const signedOut = ref(false)

onMounted(async () => {
  await me.whenSettled()
  const uid = userId(me.me)
  ownerId.value = uid
  if (uid === null) {
    signedOut.value = true
    return
  }

  try {
    const [summaries, environments] = await Promise.all([getMyAgents(), loadEnvironmentCatalog()])
    const metadata = new Map(environments.map((environment) => [environment.env_id, environment]))
    rows.value = summaries.map((summary) => ({
      summary,
      meta: metadata.get(summary.env_id) ?? null,
    }))
  } catch {
    error.value = true
  }
})

const hasRows = computed(() => rows.value !== null && rows.value.length > 0)

function environmentName(row: EnvironmentAgent): string {
  return row.meta?.display_name ?? row.summary.env_id
}

function seasonName(season: MyAgentSeasonSummary): string {
  return season.label ?? 'Unknown'
}

function seasonLink(envId: string, seasonId: string): string {
  return `/environments/${encodeURIComponent(envId)}/agents/${encodeURIComponent(ownerId.value ?? '')}?season=${encodeURIComponent(seasonId)}`
}

function seasonsFor(row: EnvironmentAgent): SeasonRow[] {
  const current = row.summary.current_season
  return [
    ...(current === null ? [] : [{ season: current, isCurrent: true }]),
    ...row.summary.previous_seasons
      .slice(0, 3)
      .map((season) => ({ season, isCurrent: false })),
  ]
}

function statusAccentClass(
  status: NonNullable<MyAgentSeasonSummary['submission']>['status'],
): string {
  return `status-${submissionStatusTone(status)}`
}

function resultLabel(season: MyAgentSeasonSummary): string {
  if (season.release_status !== 'released') {
    return 'Results not released'
  }
  return season.mean_score === null ? 'No score' : `Score ${formatScore(season.mean_score)}`
}

function currentResult(season: MyAgentSeasonSummary): string | null {
  return season.release_status === 'released' ? resultLabel(season) : null
}

function rowResult(row: SeasonRow): string | null {
  return row.isCurrent ? currentResult(row.season) : resultLabel(row.season)
}
</script>

<template>
  <section class="my-agents">
    <header class="my-agents-intro">
      <h1>My Agents</h1>
      <p class="my-agents-lede">Your current Season and recent results, by environment.</p>
    </header>

    <UiEmptyState v-if="signedOut">
      <RouterLink class="sign-in-link" to="/login">Sign in</RouterLink> to see your agents.
    </UiEmptyState>
    <UiEmptyState v-else-if="error" tone="danger">Could not load your agents.</UiEmptyState>
    <UiEmptyState v-else-if="rows === null">Loading…</UiEmptyState>
    <UiEmptyState v-else-if="!hasRows">
      There are no current Seasons or past submissions to show. Pick an
      <a href="/">environment</a> to get started.
    </UiEmptyState>
    <ul v-else class="environment-list">
      <li v-for="row in rows" :key="row.summary.env_id" class="environment-group">
        <h2>{{ environmentName(row) }}</h2>
        <ul class="season-list">
          <li v-for="seasonRow in seasonsFor(row)" :key="seasonRow.season.id">
            <RouterLink
              class="season-card-link"
              :to="seasonLink(row.summary.env_id, seasonRow.season.id)"
            >
              <UiCard interactive :padded="false">
                <div
                  class="season-row"
                  :class="
                    seasonRow.isCurrent
                      ? 'status-current'
                      : seasonRow.season.submission === null
                        ? undefined
                        : statusAccentClass(seasonRow.season.submission.status)
                  "
                >
                  <span v-if="seasonRow.isCurrent" class="sr-only">Current season</span>
                  <div class="season-row-line">
                    <span class="season-name">
                      <span aria-hidden="true">Season </span>{{ seasonName(seasonRow.season) }}
                    </span>
                    <template v-if="seasonRow.season.submission !== null">
                      <UiStatusBadge
                        :tone="submissionStatusTone(seasonRow.season.submission.status)"
                        :label="submissionStatusLabel(seasonRow.season.submission.status)"
                      />
                    </template>
                    <strong v-else class="not-submitted">Not submitted</strong>
                    <span v-if="rowResult(seasonRow) !== null" class="season-result">
                      {{ rowResult(seasonRow) }}
                    </span>
                    <span
                      v-if="seasonRow.season.submission !== null"
                      class="season-row-date"
                    >
                      <Clock :size="13" aria-hidden="true" />
                      {{ formatDate(seasonRow.season.submission.submitted_at) }}
                    </span>
                  </div>
                </div>
              </UiCard>
            </RouterLink>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.my-agents-intro {
  margin-bottom: var(--space-5);
}

.my-agents-intro h1,
.environment-group h2 {
  margin-top: 0;
}

.my-agents-intro h1 {
  margin-bottom: var(--space-1);
}

.my-agents-lede {
  margin: 0;
  color: var(--color-text-muted);
}

.sign-in-link {
  color: var(--color-accent);
}

.environment-list,
.season-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.environment-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.environment-group h2 {
  margin-bottom: var(--space-3);
  font-size: var(--text-xl);
}

.season-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.season-card-link {
  display: block;
  color: inherit;
}

.season-name {
  font-size: var(--text-sm);
  font-weight: 600;
}

.not-submitted {
  color: var(--color-warning);
  font-weight: 600;
}

.season-result {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--color-text-muted);
}
</style>
