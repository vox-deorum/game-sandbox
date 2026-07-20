<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import type { LlmDevelopmentCall } from '../api/client.js'
import { formatLlmCost } from '../lib/llm.js'
import RequestResponseView from './RequestResponseView.vue'
import UiButton from './ui/UiButton.vue'
import UiDialog from './ui/UiDialog.vue'
import UiEmptyState from './ui/UiEmptyState.vue'

withDefaults(
  defineProps<{
    calls: LlmDevelopmentCall[]
    nextCursor: number | null
    loading?: boolean
    loadingMore?: boolean
    error?: string
    title?: string
  }>(),
  {
    loading: false,
    loadingMore: false,
    error: undefined,
    title: 'Development call history',
  },
)

const emit = defineEmits<{ 'load-more': [cursor: number]; closed: [] }>()
const open = defineModel<boolean>('open', { required: true })
const selected = ref<LlmDevelopmentCall | null>(null)
const listViewport = ref<HTMLElement | null>(null)
let listScrollTop = 0

watch(open, (isOpen) => {
  if (!isOpen) {
    selected.value = null
    listScrollTop = 0
    emit('closed')
  }
})

function inspect(call: LlmDevelopmentCall): void {
  listScrollTop = listViewport.value?.scrollTop ?? 0
  selected.value = call
}

async function back(): Promise<void> {
  selected.value = null
  await nextTick()
  if (listViewport.value) listViewport.value.scrollTop = listScrollTop
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}
</script>

<template>
  <UiDialog v-model:open="open" :title="title">
    <div class="dialog-actions">
      <UiButton v-if="selected" variant="ghost" size="tight" @click="back">Back</UiButton>
      <UiButton variant="ghost" size="tight" @click="open = false">Close</UiButton>
    </div>
    <div v-if="selected" class="call-detail">
      <dl class="token-detail">
        <div><dt>Date</dt><dd>{{ formatDate(selected.created_at) }}</dd></div>
        <div><dt>Model</dt><dd>{{ selected.model }}</dd></div>
        <div><dt>Input tokens</dt><dd>{{ selected.input_tokens.toLocaleString() }}</dd></div>
        <div>
          <dt>Reasoning tokens</dt>
          <dd>{{ selected.reasoning_tokens.toLocaleString() }} (within output)</dd>
        </div>
        <div><dt>Output tokens</dt><dd>{{ selected.output_tokens.toLocaleString() }}</dd></div>
        <div><dt>Cost weight</dt><dd>{{ selected.cost_weight }} units/token</dd></div>
        <div><dt>Budget cost</dt><dd>{{ formatLlmCost(selected.budget_cost_units) }}</dd></div>
      </dl>
      <RequestResponseView :request="selected.request" :response="selected.completion" />
    </div>

    <div v-else ref="listViewport" class="call-list-viewport">
      <UiEmptyState v-if="loading">Loading call history…</UiEmptyState>
      <template v-else>
        <UiEmptyState v-if="error" tone="danger">{{ error }}</UiEmptyState>
        <UiEmptyState v-if="calls.length === 0 && error == null">No successful calls.</UiEmptyState>
        <ol v-if="calls.length > 0" class="call-list">
          <li v-for="call in calls" :key="call.id">
            <button type="button" class="call-row" @click="inspect(call)">
              <span class="date">{{ formatDate(call.created_at) }}</span>
              <strong>{{ call.model }}</strong>
              <span>{{ call.input_tokens.toLocaleString() }} input</span>
              <span>{{ call.reasoning_tokens.toLocaleString() }} reasoning</span>
              <span>{{ call.output_tokens.toLocaleString() }} output</span>
              <span>{{ formatLlmCost(call.budget_cost_units) }}</span>
            </button>
          </li>
        </ol>
        <UiButton
          v-if="nextCursor !== null"
          variant="secondary"
          :loading="loadingMore"
          @click="emit('load-more', nextCursor)"
        >
          Load more
        </UiButton>
      </template>
    </div>
  </UiDialog>
</template>

<style scoped>
.call-list-viewport,
.call-detail {
  display: grid;
  gap: var(--space-3);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.dialog-actions > :first-child:not(:only-child) {
  margin-right: auto;
}

.call-list-viewport {
  max-height: 65vh;
  overflow-y: auto;
}

.call-list {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.call-row {
  display: grid;
  grid-template-columns: minmax(10rem, 1.5fr) repeat(5, minmax(max-content, 1fr));
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-3);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  cursor: pointer;
  text-align: left;
  font: inherit;
  font-size: var(--text-xs);
}

.call-row:hover {
  border-color: var(--color-border-strong);
}

.date,
.call-row span:last-child,
dd {
  font-family: var(--font-mono);
}

.token-detail {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: var(--space-3);
  margin: 0;
}

.token-detail div {
  display: grid;
  gap: var(--space-1);
}

dt {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

dd {
  margin: 0;
  font-size: var(--text-sm);
}

@media (max-width: 768px) {
  .call-row {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
