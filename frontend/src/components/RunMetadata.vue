<script setup lang="ts">
import { computed } from 'vue'

import type { RecordingLlmTelemetry } from '../api/client.js'
import LlmCostTooltip from './LlmCostTooltip.vue'

// Shared display for run facts that can appear on both replay and terminal session screens.
export interface RunMetadataItem {
  label: string
  value: string | number | null | undefined
  code?: boolean
  /** An optional tooltip for the value — e.g. the stable id behind a display-name value. */
  title?: string
}

const props = defineProps<{
  items: RunMetadataItem[]
  /** Successful whole-recording telemetry. Omit this prop when telemetry is unavailable. */
  llmTelemetry?: RecordingLlmTelemetry
}>()

// A compact inline strip: only the facts that have a value, so the row never carries empty slots.
const shown = computed(() =>
  props.items.filter(
    (item) => item.value !== null && item.value !== undefined && item.value !== '',
  ),
)
</script>

<template>
  <dl class="run-metadata">
    <div v-for="item in shown" :key="item.label" class="run-metadata-item">
      <dt>{{ item.label }}</dt>
      <dd :title="item.title">
        <code v-if="item.code">{{ item.value }}</code>
        <template v-else>{{ item.value }}</template>
      </dd>
    </div>
    <div v-if="llmTelemetry !== undefined" class="run-metadata-item">
      <dt>LLM</dt>
      <dd>
        <LlmCostTooltip
          :calls="llmTelemetry.calls"
          :total-budget-cost-units="llmTelemetry.total_budget_cost_units"
          accessible-label="Show whole-recording LLM cost details"
        />
      </dd>
    </div>
  </dl>
</template>

<style scoped>
/* One horizontal, wrapping line of "label value" facts — the stage chrome stays quiet beside the
   renderer, so the metadata reads at a glance rather than as a stacked block. */
.run-metadata {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
  margin: 0 0 var(--space-4);
  color: var(--color-text);
  font-size: var(--text-sm);
}

.run-metadata-item {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-1);
  min-width: 0;
}

/* A middot separator between facts, drawn on every item after the first. */
.run-metadata-item + .run-metadata-item::before {
  content: '·';
  margin-right: var(--space-2);
  color: var(--color-text-muted);
}

.run-metadata dt {
  color: var(--color-text-muted);
}

.run-metadata dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.run-metadata code {
  font-family: var(--font-mono);
}
</style>
