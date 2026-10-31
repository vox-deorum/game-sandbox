<!--
  The LLM Playground at /llm. Anyone who can participate pastes a development key to see its season
  and remaining budget, then tries a prompt with it. The key lives only in this component's state:
  checking it spends nothing, and each prompt run is an ordinary metered development call.

  Operators also see the deployment upstream with a live check per alias, and can send prompts
  straight to the upstream, unmetered and unrecorded.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  type AdminLlmInfo,
  checkLlmDevelopmentKey,
  getAdminLlm,
  type LlmDevelopmentSeason,
  type LlmFailure,
  type LlmKeyCheck,
  type LlmTestOutcome,
  type LlmTestRequest,
  runAdminLlmChat,
  runLlmDevelopmentChat,
} from '../api/client.js'
import LlmPlayground from '../components/LlmPlayground.vue'
import LlmUpstreamCard from '../components/LlmUpstreamCard.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiField from '../components/ui/UiField.vue'
import UiInput from '../components/ui/UiInput.vue'
import UiMeter from '../components/ui/UiMeter.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { describeLlmError, formatLlmCost } from '../lib/llm.js'
import { canParticipate, isAdmin, useMe } from '../me.js'

const me = useMe()
const access = ref<'loading' | 'denied' | 'participant' | 'operator'>('loading')
const upstream = ref<AdminLlmInfo | null>(null)
const upstreamError = ref(false)
// An operator's preferred prompt target; `via` falls back to whichever target is ready.
const through = ref('upstream')
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

const upstreamReady = computed(() => upstream.value?.configured === true)

/** Where the next prompt goes, or null while nothing is ready to receive one. */
const via = computed<'upstream' | 'key' | null>(() => {
  if (upstreamReady.value && (through.value === 'upstream' || season.value === null)) return 'upstream'
  return season.value === null ? null : 'key'
})

const tester = computed(() => {
  const info = upstream.value
  if (via.value === 'upstream' && info !== null) {
    return {
      models: info.models.map((model) => model.alias),
      run: runAdminLlmChat,
      maxTokensPlaceholder: `Default (${info.default_max_output_tokens})`,
    }
  }
  if (season.value === null) return null
  return { models: season.value.models, costWeights: season.value.cost_weights, run, explain }
})

onMounted(async () => {
  await me.whenSettled()
  if (!canParticipate(me.me)) {
    access.value = 'denied'
    return
  }
  if (!isAdmin(me.me)) {
    access.value = 'participant'
    return
  }
  access.value = 'operator'
  try {
    upstream.value = await getAdminLlm()
  } catch {
    upstreamError.value = true
  }
})

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
  // A freshly checked key is what the operator wants to try next.
  if (result?.ok) through.value = 'key'
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
          <h2>Upstream</h2>
          <span class="note">Operators only</span>
        </div>
        <UiEmptyState v-if="upstreamError" tone="danger">Could not load the LLM setup.</UiEmptyState>
        <UiEmptyState v-else-if="upstream === null">Loading…</UiEmptyState>
        <LlmUpstreamCard v-else :info="upstream" />
      </section>
      <section class="llm-section">
        <h2>Development key</h2>
        <UiCard>
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
            <span class="season">{{ season.label ?? 'Season' }} · {{ season.environment }}</span>
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
      <section v-if="tester" class="llm-section">
        <h2>Prompt</h2>
        <LlmPlayground v-bind="tester">
          <template v-if="access === 'operator'" #settings>
            <UiField label="Send through">
              <template #default="{ id }">
                <UiSelect :id="id" :model-value="via ?? ''" @update:model-value="through = $event">
                  <option v-if="upstreamReady" value="upstream">Upstream (unmetered)</option>
                  <option v-if="season" value="key">Development key (metered)</option>
                </UiSelect>
              </template>
            </UiField>
          </template>
        </LlmPlayground>
      </section>
    </template>
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

.note,
.season {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
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
