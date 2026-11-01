<!--
  The LLM Playground at /llm, the one place to get and try a development key. It lists every open,
  LLM-enabled season with a create or rotate action, then checks a key (spending nothing) and runs
  prompts with it. Each prompt run is an ordinary metered development call, for operators too. The
  key lives only in this component's state.

  Operators also see the deployment upstream with a live check per alias.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  type AdminLlmInfo,
  checkLlmDevelopmentKey,
  getAdminLlm,
  type LlmDevelopmentCredential,
  type LlmDevelopmentSeason,
  type LlmFailure,
  type LlmKeyCheck,
  type LlmTestOutcome,
  type LlmTestRequest,
  listLlmDevelopmentSeasons,
  rotateLlmDevelopmentKey,
  runLlmDevelopmentChat,
} from '../api/client.js'
import DevelopmentCredentialDialog from '../components/DevelopmentCredentialDialog.vue'
import LlmPlayground from '../components/LlmPlayground.vue'
import LlmUpstreamCard from '../components/LlmUpstreamCard.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiConfirmDialog from '../components/ui/UiConfirmDialog.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiField from '../components/ui/UiField.vue'
import UiInput from '../components/ui/UiInput.vue'
import UiMeter from '../components/ui/UiMeter.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { describeLlmError, formatLlmCost } from '../lib/llm.js'
import { canParticipate, isAdmin, useMe } from '../me.js'

const me = useMe()
const access = ref<'loading' | 'denied' | 'participant' | 'operator'>('loading')
const upstream = ref<AdminLlmInfo | null>(null)
const upstreamError = ref(false)
// The seasons that can issue a key right now: open for submissions with LLM access.
const keySeasons = ref<LlmDevelopmentSeason[] | null>(null)
const keySeasonsError = ref(false)
const keyBusySeasonId = ref<string | null>(null)
const keyError = ref('')
const rotateSeason = ref<LlmDevelopmentSeason | null>(null)
const rotateOpen = ref(false)
const credential = ref<LlmDevelopmentCredential | null>(null)
const credentialOpen = ref(false)
const key = ref('')
// The key the current season result belongs to, so editing the field cannot run a stale check.
const checkedKey = ref('')
// Bumped by each Check, so a slower earlier response cannot overwrite a newer one.
let latestCheck = 0
const checking = ref(false)
const season = ref<LlmDevelopmentSeason | null>(null)
const checkError = ref('')

const remainingText = computed(() =>
  season.value === null
    ? ''
    : `${formatLlmCost(season.value.budget_cost_units_remaining)} left of ${formatLlmCost(season.value.limits.token_budget)}`,
)

onMounted(async () => {
  await me.whenSettled()
  if (!canParticipate(me.me)) {
    access.value = 'denied'
    return
  }
  access.value = isAdmin(me.me) ? 'operator' : 'participant'
  void loadKeySeasons()
  if (access.value !== 'operator') return
  try {
    upstream.value = await getAdminLlm()
  } catch {
    upstreamError.value = true
  }
})

async function loadKeySeasons(): Promise<void> {
  keySeasonsError.value = false
  try {
    keySeasons.value = await listLlmDevelopmentSeasons()
  } catch {
    keySeasonsError.value = true
  }
}

function seasonName(value: LlmDevelopmentSeason): string {
  return `${value.label ?? 'Season'} · ${value.environment}`
}

function requestKey(target: LlmDevelopmentSeason): void {
  keyError.value = ''
  if (target.key_exists) {
    rotateSeason.value = target
    rotateOpen.value = true
    return
  }
  void issueKey(target)
}

/** Create or rotate the key, show it once, and check it so the prompt tester is ready. */
async function issueKey(target: LlmDevelopmentSeason): Promise<void> {
  keyBusySeasonId.value = target.season_id
  keyError.value = ''
  try {
    credential.value = await rotateLlmDevelopmentKey(target.season_id)
    target.key_exists = true
    rotateOpen.value = false
    rotateSeason.value = null
    credentialOpen.value = true
    key.value = credential.value.api_key
    void check()
  } catch {
    keyError.value = 'Could not create the development key.'
  } finally {
    keyBusySeasonId.value = null
  }
}

function explain(failure: LlmFailure): string {
  return describeLlmError(failure.code, failure.message)
}

function apply(value: string, result: LlmKeyCheck | null): void {
  season.value = result?.ok ? result.season : null
  checkedKey.value = result?.ok ? value : ''
  checkError.value = result === null ? 'Could not check the key.' : result.ok ? '' : explain(result)
}

async function fetchCheck(value: string): Promise<LlmKeyCheck | null> {
  try {
    return await checkLlmDevelopmentKey(value)
  } catch {
    return null
  }
}

async function check(): Promise<void> {
  const value = key.value.trim()
  if (value === '') return
  const ticket = ++latestCheck
  checking.value = true
  const result = await fetchCheck(value)
  if (ticket !== latestCheck) return
  checking.value = false
  apply(value, result)
}

/** Refresh the budget for the key a run used, unless another key was checked since. */
async function refresh(value: string): Promise<void> {
  const ticket = latestCheck
  const result = await fetchCheck(value)
  if (ticket === latestCheck && value === checkedKey.value) apply(value, result)
}

async function run(request: LlmTestRequest): Promise<LlmTestOutcome> {
  const value = checkedKey.value
  const outcome = await runLlmDevelopmentChat(value, request)
  void refresh(value)
  return outcome
}
</script>

<template>
  <section class="llm-playground">
    <h1>LLM Playground</h1>
    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      Sign in with an approved account to use the LLM Playground.
    </UiEmptyState>
    <template v-else>
      <section v-if="access === 'operator'" class="llm-section">
        <div class="section-head">
          <h2>Upstream Status</h2>
          <span class="note">Operators only</span>
        </div>
        <UiEmptyState v-if="upstreamError" tone="danger">Could not load the LLM setup.</UiEmptyState>
        <UiEmptyState v-else-if="upstream === null">Loading…</UiEmptyState>
        <LlmUpstreamCard v-else :info="upstream" />
      </section>
      <section class="llm-section">
        <h2>API Key for Development</h2>
        <UiCard>
          <UiEmptyState v-if="keySeasonsError" tone="danger">
            Could not load the seasons with LLM access.
            <UiButton variant="secondary" size="tight" @click="loadKeySeasons">Retry</UiButton>
          </UiEmptyState>
          <UiEmptyState v-else-if="keySeasons === null">Loading…</UiEmptyState>
          <UiEmptyState v-else-if="keySeasons.length === 0">
            No open season has LLM access.
            <template v-if="access === 'operator'">
              Turn on LLM for a season in Manage and open its submissions.
            </template>
          </UiEmptyState>
          <ul v-else class="key-seasons">
            <li v-for="item in keySeasons" :key="item.season_id" class="key-season">
              <span class="key-season-name">{{ seasonName(item) }}</span>
              <span class="note">{{ item.key_exists ? 'Key issued' : 'No key yet' }}</span>
              <UiButton
                size="tight"
                variant="secondary"
                :loading="keyBusySeasonId === item.season_id"
                :disabled="keyBusySeasonId !== null"
                @click="requestKey(item)"
              >
                {{ item.key_exists ? 'Rotate development key' : 'Create development key' }}
              </UiButton>
            </li>
          </ul>
          <UiEmptyState v-if="keyError" tone="danger">{{ keyError }}</UiEmptyState>
          <form class="key-form" @submit.prevent="check()">
            <UiField label="API key">
              <template #default="{ id }">
                <UiInput
                  :id="id"
                  v-model="key"
                  type="password"
                  autocomplete="off"
                  placeholder="sk-sandbox-dev-…"
                />
              </template>
            </UiField>
            <UiButton type="submit" :loading="checking" :disabled="key.trim() === ''">
              Check
            </UiButton>
          </form>
          <div v-if="season" class="key-result">
            <UiStatusBadge tone="success" label="Key works" />
            <span class="note">{{ seasonName(season) }}</span>
            <UiMeter
              :value="season.budget_cost_units_used"
              :max="season.limits.token_budget"
              :text-value="remainingText"
              label="Development budget"
            />
          </div>
          <UiEmptyState v-else-if="checkError" tone="danger">{{ checkError }}</UiEmptyState>
        </UiCard>
      </section>
      <section v-if="season" class="llm-section">
        <h2>Test Your Prompt</h2>
        <LlmPlayground
          :models="season.models"
          :cost-weights="season.cost_weights"
          :run="run"
          :explain="explain"
        />
      </section>
    </template>

    <UiConfirmDialog
      v-model:open="rotateOpen"
      title="Rotate development key?"
      description="The current key will stop working immediately. Accumulated usage remains."
      confirm-label="Rotate development key"
      confirm-variant="danger"
      :confirm-loading="rotateSeason !== null && keyBusySeasonId === rotateSeason.season_id"
      cancel-label="Cancel"
      @confirm="rotateSeason !== null && issueKey(rotateSeason)"
      @cancel="rotateSeason = null"
    />
    <DevelopmentCredentialDialog
      v-model:open="credentialOpen"
      :credential="credential"
      @cleared="credential = null"
    />
  </section>
</template>

<style scoped>
.llm-playground {
  display: grid;
  gap: var(--space-5);
  max-width: 56rem;
}

.llm-playground h1,
.llm-section h2 {
  margin: 0;
}

.llm-section {
  display: grid;
  gap: var(--space-3);
}

.section-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
}

.note {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.key-seasons {
  display: grid;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
  padding: 0 0 var(--space-4);
  list-style: none;
  border-bottom: 1px solid var(--color-border);
}

.key-season {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--space-3);
}

.key-season-name {
  overflow-wrap: anywhere;
}

.key-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: var(--space-3);
}

.key-result {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
