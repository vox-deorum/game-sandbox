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
  type LlmDevelopmentCredential,
  type LlmDevelopmentSeason,
  listLlmDevelopmentSeasons,
  type MyAgentEnvironmentSummary,
  type MyAgentSeasonSummary,
  rotateLlmDevelopmentKey,
} from '../api/client.js'
import DevelopmentCredentialDialog from '../components/DevelopmentCredentialDialog.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiDialog from '../components/ui/UiDialog.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiMeter from '../components/ui/UiMeter.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { loadEnvironmentCatalog } from '../environmentCatalog.js'
import { formatDate, formatScore } from '../lib/format.js'
import { formatLlmCost } from '../lib/llm.js'
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
const developmentSeasons = ref<LlmDevelopmentSeason[]>([])
const developmentError = ref(false)
const keyBusySeasonId = ref<string | null>(null)
const keyError = ref<string | null>(null)
const confirmSeason = ref<LlmDevelopmentSeason | null>(null)
const confirmOpen = ref(false)
const credential = ref<LlmDevelopmentCredential | null>(null)
const credentialOpen = ref(false)

onMounted(async () => {
  await me.whenSettled()
  const uid = userId(me.me)
  ownerId.value = uid
  if (uid === null) {
    signedOut.value = true
    return
  }

  try {
    const [summaries, environments] = await Promise.all([
      getMyAgents(),
      loadEnvironmentCatalog(),
      loadDevelopmentSeasons(),
    ])
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
const developmentBySeason = computed(
  () =>
    new Map(
      developmentSeasons.value.map((development) => [
        `${development.environment}\u0000${development.season_id}`,
        development,
      ]),
    ),
)

async function loadDevelopmentSeasons(): Promise<void> {
  developmentError.value = false
  try {
    developmentSeasons.value = await listLlmDevelopmentSeasons()
  } catch {
    developmentSeasons.value = []
    developmentError.value = true
  }
}

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

function rowAccessibleLabel(row: SeasonRow): string {
  return [
    row.isCurrent ? 'Current season' : null,
    seasonName(row.season),
    row.season.submission === null
      ? 'Not submitted'
      : submissionStatusLabel(row.season.submission.status),
    rowResult(row),
  ]
    .filter((part): part is string => part !== null)
    .join(' ')
}

function developmentFor(envId: string, row: SeasonRow): LlmDevelopmentSeason | null {
  if (!row.isCurrent) {
    return null
  }
  return developmentBySeason.value.get(`${envId}\u0000${row.season.id}`) ?? null
}

function meterText(development: LlmDevelopmentSeason): string {
  return `${formatLlmCost(development.budget_cost_units_used)} used of ${formatLlmCost(development.limits.token_budget)}`
}

async function createOrConfirm(development: LlmDevelopmentSeason): Promise<void> {
  if (keyBusySeasonId.value !== null) return
  keyError.value = null
  if (development.key_exists) {
    confirmSeason.value = development
    confirmOpen.value = true
    return
  }
  await issueKey(development)
}

async function issueKey(development: LlmDevelopmentSeason): Promise<void> {
  keyBusySeasonId.value = development.season_id
  keyError.value = null
  try {
    credential.value = await rotateLlmDevelopmentKey(development.season_id)
    development.key_exists = true
    confirmOpen.value = false
    confirmSeason.value = null
    credentialOpen.value = true
  } catch {
    keyError.value = 'Could not create the development key.'
  } finally {
    keyBusySeasonId.value = null
  }
}

function cancelRotation(): void {
  confirmOpen.value = false
  confirmSeason.value = null
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
            <UiCard class="season-card" interactive :padded="false">
              <RouterLink
                class="season-card-link"
                :to="seasonLink(row.summary.env_id, seasonRow.season.id)"
                :aria-label="rowAccessibleLabel(seasonRow)"
              />
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
                  <div
                    v-if="developmentFor(row.summary.env_id, seasonRow)"
                    class="development-access"
                  >
                    <UiMeter
                      :value="developmentFor(row.summary.env_id, seasonRow)!.budget_cost_units_used"
                      :max="developmentFor(row.summary.env_id, seasonRow)!.limits.token_budget"
                      :text-value="meterText(developmentFor(row.summary.env_id, seasonRow)!)"
                      label="Development usage"
                    />
                    <UiButton
                      class="development-key-action"
                      size="tight"
                      variant="secondary"
                      :loading="keyBusySeasonId === seasonRow.season.id"
                      :disabled="keyBusySeasonId !== null"
                      @click="createOrConfirm(developmentFor(row.summary.env_id, seasonRow)!)"
                    >
                      {{
                        developmentFor(row.summary.env_id, seasonRow)!.key_exists
                          ? 'Rotate development key'
                          : 'Create development key'
                      }}
                    </UiButton>
                  </div>
                </div>
            </UiCard>
          </li>
        </ul>
      </li>
    </ul>
    <UiEmptyState v-if="developmentError" tone="danger">
      Could not load development access.
      <UiButton variant="secondary" size="tight" @click="loadDevelopmentSeasons">Retry</UiButton>
    </UiEmptyState>
    <UiEmptyState v-if="keyError !== null" tone="danger">{{ keyError }}</UiEmptyState>

    <UiDialog
      v-model:open="confirmOpen"
      title="Rotate development key?"
      description="The current key will stop working immediately. Accumulated usage remains."
    >
      <div class="dialog-actions">
        <UiButton
          variant="danger"
          :loading="confirmSeason !== null && keyBusySeasonId === confirmSeason.season_id"
          @click="confirmSeason !== null && issueKey(confirmSeason)"
        >
          Rotate development key
        </UiButton>
        <UiButton variant="secondary" @click="cancelRotation">Cancel</UiButton>
      </div>
    </UiDialog>

    <DevelopmentCredentialDialog
      v-model:open="credentialOpen"
      :credential="credential"
      @cleared="credential = null"
    />
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

.season-card {
  position: relative;
}

.season-card-link {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: inherit;
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

.development-access {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  padding: 0 var(--space-4) var(--space-3);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

@media (max-width: 480px) {
  .development-access {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
