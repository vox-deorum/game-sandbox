<!--
  The student LLM test page at /my/llm. The pasted development key lives only in this component's
  state: checking it spends nothing, and each prompt run is an ordinary metered development call.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  checkLlmDevelopmentKey,
  type LlmDevelopmentSeason,
  type LlmFailure,
  type LlmKeyCheck,
  type LlmTestOutcome,
  type LlmTestRequest,
  runLlmDevelopmentChat,
} from '../api/client.js'
import LlmPlayground from '../components/LlmPlayground.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiField from '../components/ui/UiField.vue'
import UiInput from '../components/ui/UiInput.vue'
import UiMeter from '../components/ui/UiMeter.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { describeLlmError, formatLlmCost } from '../lib/llm.js'
import { canParticipate, useMe } from '../me.js'

const me = useMe()
const access = ref<'loading' | 'denied' | 'ready'>('loading')
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
  access.value = canParticipate(me.me) ? 'ready' : 'denied'
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
  <section class="llm-test">
    <h1>Test LLM key</h1>
    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      Sign in with an approved account to test a key.
    </UiEmptyState>
    <template v-else>
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
      <LlmPlayground
        v-if="season"
        :models="season.models"
        :cost-weights="season.cost_weights"
        :run="run"
        :explain="explain"
      />
    </template>
  </section>
</template>

<style scoped>
.llm-test {
  display: grid;
  gap: var(--space-4);
  max-width: 48rem;
}

.llm-test h1 {
  margin: 0;
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

.season {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
</style>
