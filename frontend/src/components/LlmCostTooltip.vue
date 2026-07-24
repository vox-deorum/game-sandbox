<!--
  The LLM cost trigger: a run's or a decision's cost, with the call breakdown in a tooltip. It is the
  UiTooltip primitive filled with LlmCostDetails, so every cost figure in the app hovers, focuses, and
  pins the same way. Where every call carries its bodies the trigger is `inspectable`: activating it
  emits `inspect` for the caller's request/response dialog instead of pinning the tooltip open.
-->
<script setup lang="ts">
import { computed } from 'vue'

import type { LlmUsageByModel } from '../api/client.js'
import { formatLlmCost } from '../lib/llm.js'
import LlmCostDetails, { type LlmCostDetailCall } from './LlmCostDetails.vue'
import UiTooltip from './ui/UiTooltip.vue'

const props = withDefaults(
  defineProps<{
    calls?: LlmCostDetailCall[]
    usageByModel?: LlmUsageByModel | null
    totalBudgetCostUnits: number
    label?: string
    accessibleLabel?: string
    inspectable?: boolean
  }>(),
  {
    calls: () => [],
    usageByModel: null,
    label: undefined,
    accessibleLabel: undefined,
    inspectable: false,
  },
)

const emit = defineEmits<{ inspect: [] }>()

const triggerLabel = computed(() => props.label ?? formatLlmCost(props.totalBudgetCostUnits))
</script>

<template>
  <UiTooltip
    :accessible-label="accessibleLabel ?? `LLM cost details: ${triggerLabel}`"
    :inspectable="inspectable"
    @inspect="emit('inspect')"
  >
    <slot>{{ triggerLabel }}</slot>
    <template #content>
      <LlmCostDetails
        :calls="calls"
        :usage-by-model="usageByModel"
        :total-budget-cost-units="totalBudgetCostUnits"
      />
    </template>
  </UiTooltip>
</template>
