<!--
  The operator's view of the deployment upstream on the LLM Playground: its URL, whether a key is
  set, and a live check per model alias. Every check goes straight to the upstream, unmetered and
  unrecorded.
-->
<script setup lang="ts">
import { reactive } from 'vue'

import {
  type AdminLlmInfo,
  type LlmFailure,
  type LlmModelAlias,
  type LlmTestOutcome,
  runAdminLlmChat,
} from '../api/client.js'
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
  <UiEmptyState v-if="!info.configured">
    No upstream configured. Set LLM_UPSTREAM_URL and an LLM_MODEL_* alias.
  </UiEmptyState>
  <UiCard v-else>
    <header class="card-header">
      <p class="upstream">
        <span class="mono">{{ info.upstream_url }}</span>
        <span>{{ info.key_set ? 'Key set' : 'No key' }}</span>
      </p>
      <UiButton size="tight" variant="secondary" @click="testAll">Test all</UiButton>
    </header>
    <table class="alias-table">
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
</style>
