<script lang="ts">
export interface LlmCostDetailCall {
  model: string
  input_tokens: number
  reasoning_tokens: number
  output_tokens: number
  cost_weight: number
  budget_cost_units: number
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

import type { LlmUsageByModel } from '../api/client.js'
import { formatLlmCost } from '../lib/llm.js'

const props = withDefaults(
  defineProps<{
    calls?: LlmCostDetailCall[]
    usageByModel?: LlmUsageByModel | null
    totalBudgetCostUnits: number
    /** Use the compact `By model` disclosure required by automated-board rows. */
    byModelDisclosure?: boolean
  }>(),
  { calls: () => [], usageByModel: null, byModelDisclosure: false },
)

const groupedCalls = computed(() => {
  const groups = new Map<string, number>()
  for (const call of props.calls) groups.set(call.model, (groups.get(call.model) ?? 0) + 1)
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
})

const aggregateEntries = computed(() =>
  Object.entries(props.usageByModel ?? {}).sort(([a], [b]) => a.localeCompare(b)),
)

const totalCalls = computed(() =>
  props.calls.length > 0
    ? props.calls.length
    : aggregateEntries.value.reduce((sum, [, usage]) => sum + usage.calls, 0),
)
</script>

<template>
  <component :is="byModelDisclosure ? 'details' : 'div'" class="llm-cost-details">
    <summary v-if="byModelDisclosure">By model</summary>
    <div class="detail-body">
      <p>{{ totalCalls }} successful {{ totalCalls === 1 ? 'call' : 'calls' }}</p>
      <p v-if="calls.length > 0 && groupedCalls.length > 0">
        <span v-for="([model, count], index) in groupedCalls" :key="model">
          <span v-if="index > 0"> · </span>{{ model }}: {{ count }}
        </span>
      </p>
      <ul v-if="calls.length > 0">
        <li v-for="(call, index) in calls" :key="index">
          <strong>{{ call.model }}</strong>: {{ call.cost_weight }} units/token ×
          {{ call.input_tokens.toLocaleString() }} input +
          {{ call.output_tokens.toLocaleString() }} output tokens,
          {{ call.reasoning_tokens.toLocaleString() }} reasoning tokens within output,
          {{ formatLlmCost(call.budget_cost_units) }}
        </li>
      </ul>
      <ul v-else-if="aggregateEntries.length > 0">
        <li v-for="[model, usage] in aggregateEntries" :key="model">
          <strong>{{ model }}</strong>: {{ usage.calls.toLocaleString() }}
          {{ usage.calls === 1 ? 'call' : 'calls' }},
          {{ usage.input_tokens.toLocaleString() }} input +
          {{ usage.output_tokens.toLocaleString() }} output tokens,
          {{ usage.reasoning_tokens.toLocaleString() }} reasoning tokens within output
        </li>
      </ul>
      <p><strong>Total:</strong> {{ formatLlmCost(totalBudgetCostUnits) }}</p>
    </div>
  </component>
</template>

<style scoped>
.llm-cost-details,
.detail-body {
  display: grid;
  gap: var(--space-2);
}

summary {
  cursor: pointer;
  color: var(--color-text-muted);
}

p,
ul {
  margin: 0;
}

ul {
  display: grid;
  gap: var(--space-2);
  padding-left: var(--space-5);
}

.detail-body {
  font-size: var(--text-xs);
}
</style>
