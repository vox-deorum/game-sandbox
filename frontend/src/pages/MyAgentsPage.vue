<!--
  My Agents is the signed-in student's cross-environment season index. It leads with the season
  currently accepting submissions, then keeps the three most recent seasons the student entered close
  at hand. Every season card is one link to that season in My Submissions.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
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
import { formatDate, formatScore, shortId } from '../lib/format.js'
import { submissionStatusLabel, submissionStatusTone } from '../lib/submission-status.js'
import { useMe, userId } from '../me.js'

interface EnvironmentAgent {
  summary: MyAgentEnvironmentSummary
  meta: EnvironmentMeta | null
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
  return season.label ?? `Season ${shortId(season.id)}`
}

function seasonLink(envId: string, seasonId: string): string {
  return `/environments/${encodeURIComponent(envId)}/agents/${encodeURIComponent(ownerId.value ?? '')}?season=${encodeURIComponent(seasonId)}`
}

function resultLabel(season: MyAgentSeasonSummary): string {
  if (season.release_status !== 'released') {
    return 'Results not released'
  }
  return season.mean_score === null ? 'No score' : `Score ${formatScore(season.mean_score)}`
}
</script>

<template>
  <section class="my-agents">
    <header class="my-agents-intro">
      <h1>My Agents</h1>
      <p class="my-agents-lede">Your current Season and recent results, by environment.</p>
    </header>

    <UiEmptyState v-if="signedOut">
      Sign in to see your agents. <RouterLink to="/login">Sign in</RouterLink>
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

        <section v-if="row.summary.current_season !== null" class="season-section">
          <h3>Current Season</h3>
          <RouterLink
            class="season-card-link"
            :to="seasonLink(row.summary.env_id, row.summary.current_season.id)"
          >
            <UiCard interactive>
              <div class="season-head">
                <span class="season-name">{{ seasonName(row.summary.current_season) }}</span>
                <UiStatusBadge
                  v-if="row.summary.current_season.submission !== null"
                  :tone="submissionStatusTone(row.summary.current_season.submission.status)"
                  :label="submissionStatusLabel(row.summary.current_season.submission.status)"
                />
              </div>
              <div class="season-facts">
                <span v-if="row.summary.current_season.submission !== null">
                  Submitted {{ formatDate(row.summary.current_season.submission.submitted_at) }}
                </span>
                <strong v-else class="not-submitted">Not submitted</strong>
                <span class="season-result">{{ resultLabel(row.summary.current_season) }}</span>
              </div>
            </UiCard>
          </RouterLink>
        </section>

        <section v-if="row.summary.previous_seasons.length > 0" class="season-section">
          <h3>Previous Seasons</h3>
          <ul class="previous-list">
            <li v-for="season in row.summary.previous_seasons" :key="season.id">
              <RouterLink
                class="season-card-link"
                :to="seasonLink(row.summary.env_id, season.id)"
              >
                <UiCard interactive>
                  <div class="season-head">
                    <span class="season-name">{{ seasonName(season) }}</span>
                    <UiStatusBadge
                      v-if="season.submission !== null"
                      :tone="submissionStatusTone(season.submission.status)"
                      :label="submissionStatusLabel(season.submission.status)"
                    />
                  </div>
                  <div class="season-facts">
                    <span v-if="season.submission !== null">
                      Submitted {{ formatDate(season.submission.submitted_at) }}
                    </span>
                    <strong v-else class="not-submitted">Not submitted</strong>
                    <span class="season-result">{{ resultLabel(season) }}</span>
                  </div>
                </UiCard>
              </RouterLink>
            </li>
          </ul>
        </section>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.my-agents-intro {
  margin-bottom: var(--space-5);
}

.my-agents-intro h1,
.environment-group h2,
.season-section h3 {
  margin-top: 0;
}

.my-agents-intro h1 {
  margin-bottom: var(--space-1);
}

.my-agents-lede {
  margin: 0;
  color: var(--color-text-muted);
}

.environment-list,
.previous-list {
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

.season-section + .season-section {
  margin-top: var(--space-4);
}

.season-section h3 {
  margin-bottom: var(--space-2);
  color: var(--color-text-muted);
  font-family: var(--font-body);
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.previous-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}

.season-card-link {
  display: block;
  color: inherit;
}

.season-card-link > :deep(.ui-card) {
  height: 100%;
}

.season-head,
.season-facts {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.season-head {
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.season-name {
  font-size: var(--text-lg);
  font-weight: 600;
}

.season-facts {
  justify-content: space-between;
  flex-wrap: wrap;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.not-submitted {
  color: var(--color-warning);
  font-weight: 600;
}

.season-result {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 768px) {
  .previous-list {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 480px) {
  .season-head,
  .season-facts {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--space-2);
  }
}
</style>
