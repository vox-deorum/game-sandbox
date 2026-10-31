<!--
  One-turn prompt tester shared by the student key page and the operator LLM page. The caller owns
  where the request goes (development key or direct upstream) and how a refusal is explained.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { LlmFailure, LlmModelAlias, LlmTestOutcome, LlmTestRequest } from '../api/client.js'
import { formatLlmCost } from '../lib/llm.js'
import UiButton from './ui/UiButton.vue'
import UiCard from './ui/UiCard.vue'
import UiCodeBlock from './ui/UiCodeBlock.vue'
import UiEmptyState from './ui/UiEmptyState.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'
import UiSelect from './ui/UiSelect.vue'
import UiTextarea from './ui/UiTextarea.vue'

const props = defineProps<{
  models: LlmModelAlias[]
  /** Prefills Max tokens; left blank, the deployment default applies. */
  defaultMaxTokens?: number
  run: (request: LlmTestRequest) => Promise<LlmTestOutcome>
  /** Budget weights; when given, the result also shows the weighted cost. */
  costWeights?: Partial<Record<LlmModelAlias, number>>
  explain?: (failure: LlmFailure) => string
}>()
const model = ref<string>(props.models[0] ?? '')
// `v-model.number` leaves an empty field as ''.
const maxTokens = ref<number | ''>(props.defaultMaxTokens ?? '')
const system = ref('')
const user = ref('')
const busy = ref(false)
const outcome = ref<LlmTestOutcome | null>(null)
// Priced at the submitted model, so changing the selector does not reprice an earlier reply.
const outcomeWeight = ref<number | undefined>()
const failed = ref(false)

watch(
  () => props.models,
  (models) => {
    if (!models.includes(model.value as LlmModelAlias)) model.value = models[0] ?? ''
  },
)

const reply = computed(() =>
  outcome.value?.ok ? (outcome.value.completion.choices[0]?.message.content ?? '') : '',
)

const stats = computed(() => {
  if (!outcome.value?.ok) return ''
  const usage = outcome.value.completion.usage
  const parts = usage === undefined ? [] : [`${usage.prompt_tokens} in`, `${usage.completion_tokens} out`]
  const weight = outcomeWeight.value
  if (usage !== undefined && weight !== undefined) parts.push(formatLlmCost(weight * usage.total_tokens))
  parts.push(`${outcome.value.latencyMs} ms`)
  return parts.join(' · ')
})

const errorText = computed(() => {
  const value = outcome.value
  if (value === null || value.ok) return ''
  return props.explain?.(value) ?? `${value.status} ${value.code}: ${value.message}`
})

async function submit(): Promise<void> {
  busy.value = true
  failed.value = false
  const messages = [
    ...(system.value.trim() === '' ? [] : [{ role: 'system' as const, content: system.value }]),
    { role: 'user' as const, content: user.value },
  ]
  const alias = model.value as LlmModelAlias
  const weight = props.costWeights?.[alias]
  try {
    outcome.value = await props.run({
      model: alias,
      messages,
      ...(maxTokens.value === '' ? {} : { max_completion_tokens: maxTokens.value }),
    })
    outcomeWeight.value = weight
  } catch {
    outcome.value = null
    failed.value = true
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiCard>
    <form class="playground" @submit.prevent="submit">
      <div class="settings">
        <UiField label="Model">
          <template #default="{ id }">
            <UiSelect :id="id" v-model="model">
              <option v-for="alias in models" :key="alias" :value="alias">{{ alias }}</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField label="Max tokens">
          <template #default="{ id }">
            <UiInput :id="id" v-model.number="maxTokens" type="number" min="1" placeholder="Default" />
          </template>
        </UiField>
      </div>
      <UiField label="System">
        <template #default="{ id }">
          <UiTextarea :id="id" v-model="system" rows="3" />
        </template>
      </UiField>
      <UiField label="User">
        <template #default="{ id }">
          <UiTextarea :id="id" v-model="user" rows="3" />
        </template>
      </UiField>
      <div class="actions">
        <UiButton type="submit" :loading="busy" :disabled="user.trim() === '' || model === ''">
          Run
        </UiButton>
      </div>
    </form>
    <div v-if="outcome?.ok" class="result">
      <UiCodeBlock :code="reply" copy-label="Copy reply" />
      <p class="stats">{{ stats }}</p>
    </div>
    <UiEmptyState v-else-if="errorText" tone="danger">{{ errorText }}</UiEmptyState>
    <UiEmptyState v-else-if="failed" tone="danger">Request failed.</UiEmptyState>
  </UiCard>
</template>

<style scoped>
.playground,
.result {
  display: grid;
  gap: var(--space-3);
}

.settings {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.actions {
  display: flex;
  justify-content: flex-end;
}

.result {
  margin-top: var(--space-4);
}

.stats {
  margin: 0;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
</style>
