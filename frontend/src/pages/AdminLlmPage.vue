<!--
  The operator LLM page at /admin/llm: the deployment upstream, a live check per model alias, and a
  prompt tester. Every call goes straight to the upstream, unmetered and unrecorded.
-->
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import {
  type AdminLlmInfo,
  getAdminLlm,
  type LlmFailure,
  type LlmModelAlias,
  type LlmTestOutcome,
  runAdminLlmChat,
} from '../api/client.js'
import LlmPlayground from '../components/LlmPlayground.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { isAdmin, useMe } from '../me.js'

const PROBE_MAX_TOKENS = 16

/** A running check has no outcome yet. */
interface AliasCheck {
  outcome?: LlmTestOutcome
}

const me = useMe()
const access = ref<'loading' | 'denied' | 'ready'>('loading')
const info = ref<AdminLlmInfo | null>(null)
const loadError = ref(false)
const checks = reactive<Partial<Record<LlmModelAlias, AliasCheck>>>({})

onMounted(async () => {
  await me.whenSettled()
  if (!isAdmin(me.me)) {
    access.value = 'denied'
    return
  }
  access.value = 'ready'
  try {
    info.value = await getAdminLlm()
  } catch {
    loadError.value = true
  }
})

async function test(alias: LlmModelAlias): Promise<void> {
  checks[alias] = {}
  let outcome: LlmTestOutcome
  try {
    outcome = await runAdminLlmChat({
      model: alias,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_completion_tokens: Math.min(PROBE_MAX_TOKENS, info.value?.max_output_tokens ?? PROBE_MAX_TOKENS),
    })
  } catch {
    outcome = { ok: false, status: 0, code: 'failed', message: 'Request failed.' }
  }
  checks[alias] = { outcome }
}

function testAll(): void {
  for (const model of info.value?.models ?? []) void test(model.alias)
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
  <section class="admin-llm">
    <h1>LLM</h1>
    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      This page is limited to operators.
    </UiEmptyState>
    <UiEmptyState v-else-if="loadError" tone="danger">Could not load the LLM setup.</UiEmptyState>
    <UiEmptyState v-else-if="info === null">Loading…</UiEmptyState>
    <UiEmptyState v-else-if="!info.configured">
      No upstream configured. Set LLM_UPSTREAM_URL and an LLM_MODEL_* alias.
    </UiEmptyState>
    <template v-else>
      <UiCard>
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
      <LlmPlayground
        :models="info.models.map((model) => model.alias)"
        :default-max-tokens="info.default_max_output_tokens"
        :run="runAdminLlmChat"
      />
    </template>
  </section>
</template>

<style scoped>
.admin-llm {
  display: grid;
  gap: var(--space-4);
  max-width: 56rem;
}

.admin-llm h1 {
  margin: 0;
}

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
