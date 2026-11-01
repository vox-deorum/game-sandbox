<!--
  The operator's view of the deployment upstream on the LLM Playground: its URL, whether a key is
  set, a live check per model alias, and the upstream's own model list on request. Every request goes
  straight to the upstream, unmetered and unrecorded.
-->
<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import {
  type AdminLlmInfo,
  type LlmFailure,
  type LlmModelAlias,
  type LlmModelList,
  type LlmTestOutcome,
  listAdminLlmUpstreamModels,
  runAdminLlmChat,
} from '../api/client.js'
import UiBadge from './ui/UiBadge.vue'
import UiButton from './ui/UiButton.vue'
import UiCard from './ui/UiCard.vue'
import UiEmptyState from './ui/UiEmptyState.vue'
import UiStatusBadge from './ui/UiStatusBadge.vue'

const PROBE_MAX_TOKENS = 16

/** A running check has no outcome yet. */
interface AliasCheck {
  outcome?: LlmTestOutcome
}

const props = defineProps<{ info: AdminLlmInfo }>()
const checks = reactive<Partial<Record<LlmModelAlias, AliasCheck>>>({})
/** Null until first requested, and `loading` while a request is in flight. */
const upstreamModels = ref<LlmModelList | 'loading' | null>(null)

/** The aliases mapped to each upstream model id, so the list shows which models are in use. */
const aliasesByModel = computed(() => {
  const map = new Map<string, LlmModelAlias[]>()
  for (const model of props.info.models) {
    map.set(model.upstream_model, [...(map.get(model.upstream_model) ?? []), model.alias])
  }
  return map
})

async function listModels(): Promise<void> {
  upstreamModels.value = 'loading'
  try {
    upstreamModels.value = await listAdminLlmUpstreamModels()
  } catch {
    upstreamModels.value = { ok: false, status: 0, code: 'failed', message: 'Request failed.' }
  }
}

async function test(alias: LlmModelAlias): Promise<void> {
  checks[alias] = {}
  let outcome: LlmTestOutcome
  try {
    outcome = await runAdminLlmChat({
      model: alias,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_completion_tokens: Math.min(PROBE_MAX_TOKENS, props.info.max_output_tokens),
    })
  } catch {
    outcome = { ok: false, status: 0, code: 'failed', message: 'Request failed.' }
  }
  checks[alias] = { outcome }
}

function testAll(): void {
  for (const model of props.info.models) void test(model.alias)
}

function statusLabel(outcome: LlmTestOutcome | undefined): string {
  if (outcome === undefined) return 'Testing…'
  return outcome.ok ? `OK · ${outcome.latencyMs} ms` : `${outcome.status} ${outcome.code}`
}

function statusTone(outcome: LlmTestOutcome | undefined): 'neutral' | 'success' | 'danger' {
  if (outcome === undefined) return 'neutral'
  return outcome.ok ? 'success' : 'danger'
}
</script>

<template>
  <UiEmptyState v-if="info.upstream_url === null">
    No upstream configured. Set LLM_UPSTREAM_URL and an LLM_MODEL_* alias.
  </UiEmptyState>
  <UiCard v-else>
    <header class="card-header">
      <p class="upstream">
        <span class="mono">{{ info.upstream_url }}</span>
        <span>{{ info.key_set ? 'Key set' : 'No key' }}</span>
      </p>
      <div class="actions">
        <UiButton
          size="tight"
          variant="secondary"
          :loading="upstreamModels === 'loading'"
          @click="listModels"
        >
          List models
        </UiButton>
        <UiButton v-if="info.models.length > 0" size="tight" variant="secondary" @click="testAll">
          Test all
        </UiButton>
      </div>
    </header>
    <p v-if="info.models.length === 0" class="detail">
      No model alias is set. List the upstream's models, then set an LLM_MODEL_* variable to one of them.
    </p>
    <table v-else class="alias-table">
      <thead>
        <tr>
          <th>Alias</th>
          <th>Upstream model</th>
          <th>Status</th>
          <th><span class="visually-hidden">Action</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="model in info.models" :key="model.alias">
          <td class="mono">{{ model.alias }}</td>
          <td class="mono">{{ model.upstream_model }}</td>
          <td>
            <template v-if="checks[model.alias]">
              <UiStatusBadge
                :label="statusLabel(checks[model.alias]!.outcome)"
                :tone="statusTone(checks[model.alias]!.outcome)"
              />
              <p v-if="checks[model.alias]!.outcome?.ok === false" class="detail">
                {{ (checks[model.alias]!.outcome as LlmFailure).message }}
              </p>
            </template>
          </td>
          <td>
            <UiButton
              size="tight"
              variant="ghost"
              :aria-label="`Test ${model.alias}`"
              :loading="checks[model.alias] !== undefined && checks[model.alias]!.outcome === undefined"
              @click="test(model.alias)"
            >
              Test
            </UiButton>
          </td>
        </tr>
      </tbody>
    </table>
    <section
      v-if="upstreamModels !== null && upstreamModels !== 'loading'"
      class="upstream-models"
      aria-label="Upstream models"
    >
      <template v-if="upstreamModels.ok">
        <h3>Upstream models · {{ upstreamModels.models.length }}</h3>
        <!-- Focusable so keyboard users can scroll a long list; WebKit skips plain scroll areas. -->
        <ul
          v-if="upstreamModels.models.length > 0"
          class="model-list"
          tabindex="0"
          aria-label="Upstream model list"
        >
          <li v-for="id in upstreamModels.models" :key="id">
            <span class="mono">{{ id }}</span>
            <UiBadge v-for="alias in aliasesByModel.get(id) ?? []" :key="alias" variant="accent">
              {{ alias }}
            </UiBadge>
          </li>
        </ul>
        <p v-else class="detail">The upstream lists no models.</p>
      </template>
      <template v-else>
        <UiStatusBadge :label="`${upstreamModels.status} ${upstreamModels.code}`" tone="danger" />
        <p class="detail">{{ upstreamModels.message }}</p>
      </template>
    </section>
  </UiCard>
</template>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.upstream {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.mono {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}

.alias-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.alias-table th,
.alias-table td {
  text-align: left;
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}

.alias-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.detail {
  margin: var(--space-1) 0 0;
  color: var(--color-text-muted);
}

.upstream-models {
  margin-top: var(--space-4);
  font-size: var(--text-sm);
}

.upstream-models h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

/* A provider such as OpenRouter lists hundreds of models, so the list wraps into columns and scrolls. */
.model-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: var(--space-1) var(--space-3);
  max-height: 18rem;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
}

.model-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
</style>
