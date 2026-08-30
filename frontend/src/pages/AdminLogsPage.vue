<!--
  The current-process log viewer at /admin/logs. It is an operator-only, in-memory view: clearing it
  only changes this browser's baseline, while the backend remains the authority for retention and
  access. Snapshots replace the visible filter result; tails append new sequence numbers after the
  cursor so a quiet filter still advances through the live buffer.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import {
  getAdminLogs,
  type AdminLogsParams,
  type BackendLogEntry,
  type BackendLogLevel,
  type BackendLogSource,
} from '../api/client.js'
import { useLatestRequest } from '../composables/useLatestRequest.js'
import BackendLogTable from '../components/admin/BackendLogTable.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiInput from '../components/ui/UiInput.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { isAdmin, useMe } from '../me.js'

type Access = 'loading' | 'denied' | 'ready'
type LevelTab = 'all' | BackendLogLevel
type LoadKind = 'snapshot' | 'tail'

const POLL_INTERVAL_MS = 2_000
const SEARCH_DEBOUNCE_MS = 250
const LEVEL_TABS: { key: LevelTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'info', label: 'Info' },
  { key: 'warn', label: 'Warnings' },
  { key: 'error', label: 'Errors' },
]

const me = useMe()
const access = ref<Access>('loading')
const entries = ref<BackendLogEntry[]>([])
const levelTab = ref<LevelTab>('all')
const source = ref<BackendLogSource | ''>('')
const query = ref('')
const appliedQuery = ref('')
const sources = ref<BackendLogSource[]>([])
const live = ref(true)
const loading = ref(false)
const hasSuccessfulResponse = ref(false)
const error = ref<string | null>(null)
const historyTruncated = ref(false)
const retainedCount = ref(0)
const retainedBytes = ref(0)
const bootId = ref<string | null>(null)
const cursor = ref<number | null>(null)
// After a browser-local clear, this is the sequence number from which later live tails begin.
const baselineSeq = ref<number | null>(null)

const latestRequest = useLatestRequest()
let controller: AbortController | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let mounted = true

const shownCount = computed(() => entries.value.length)

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function clearPollTimer(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function clearSearchTimer(): void {
  if (searchTimer !== null) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
}

/** Apply the visible search value before a discrete filter action replaces the snapshot. */
function commitSearchQuery(): void {
  clearSearchTimer()
  appliedQuery.value = query.value
}

function abortRequest(): void {
  latestRequest.invalidate()
  controller?.abort()
  controller = null
  loading.value = false
}

function requestParams(kind: LoadKind): AdminLogsParams {
  const afterSeq = kind === 'tail' ? (cursor.value ?? baselineSeq.value) : baselineSeq.value
  return {
    ...(afterSeq === null ? {} : { afterSeq }),
    ...(levelTab.value === 'all' ? {} : { level: levelTab.value }),
    ...(source.value === '' ? {} : { source: source.value }),
    q: appliedQuery.value,
  }
}

function scheduleTail(): void {
  clearPollTimer()
  if (!mounted || access.value !== 'ready' || !live.value) {
    return
  }
  pollTimer = setTimeout(() => {
    pollTimer = null
    void load('tail')
  }, POLL_INTERVAL_MS)
}

function applyTail(next: BackendLogEntry[], oldestSeq: number | null): void {
  if (oldestSeq === null) {
    entries.value = []
    return
  }
  const seen = new Set(entries.value.map((entry) => entry.seq))
  entries.value = [
    ...entries.value.filter((entry) => entry.seq >= oldestSeq),
    ...next.filter((entry) => entry.seq >= oldestSeq && !seen.has(entry.seq)),
  ]
}

async function load(kind: LoadKind): Promise<void> {
  if (!mounted || access.value !== 'ready' || (kind === 'tail' && !live.value)) {
    return
  }
  const isCurrent = latestRequest.begin()
  const requestController = new AbortController()
  controller = requestController
  loading.value = true
  error.value = null

  try {
    const response = await getAdminLogs(requestParams(kind), { signal: requestController.signal })
    if (!isCurrent()) {
      return
    }
    if (bootId.value !== null && bootId.value !== response.boot_id) {
      // Sequence numbers belong to a process boot. Do not blend a restarted backend's log into the
      // old one: discard every bit of its view, then replace it from a new snapshot immediately.
      entries.value = []
      cursor.value = null
      baselineSeq.value = null
      bootId.value = null
      sources.value = []
      const hadSourceFilter = source.value !== ''
      source.value = ''
      retainedCount.value = 0
      retainedBytes.value = 0
      historyTruncated.value = false
      hasSuccessfulResponse.value = false
      abortRequest()
      // Clearing a selected source triggers the normal filter watcher, which starts the replacement
      // snapshot. With no source selected it will not run, so start that snapshot directly instead.
      if (!hadSourceFilter) {
        void load('snapshot')
      }
      return
    }

    bootId.value = response.boot_id
    sources.value = response.sources
    retainedCount.value = response.retained_count
    retainedBytes.value = response.retained_bytes
    historyTruncated.value ||= response.history_truncated
    cursor.value = response.latest_seq
    if (kind === 'snapshot') {
      entries.value = response.entries
    } else {
      applyTail(response.entries, response.oldest_seq)
    }
    hasSuccessfulResponse.value = true
  } catch (caught) {
    if (!isCurrent() || requestController.signal.aborted) {
      return
    }
    error.value = caught instanceof Error ? caught.message : 'Could not load process logs.'
  } finally {
    if (isCurrent()) {
      if (controller === requestController) {
        controller = null
      }
      loading.value = false
      scheduleTail()
    }
  }
}

function refreshSnapshot(): void {
  clearPollTimer()
  abortRequest()
  void load('snapshot')
}

function onClear(): void {
  if (!hasSuccessfulResponse.value) {
    return
  }
  clearPollTimer()
  abortRequest()
  entries.value = []
  baselineSeq.value = cursor.value
  error.value = null
  historyTruncated.value = false
  scheduleTail()
}

function pause(): void {
  live.value = false
  clearPollTimer()
  abortRequest()
}

function resume(): void {
  live.value = true
  clearPollTimer()
  void load(hasSuccessfulResponse.value ? 'tail' : 'snapshot')
}

watch([levelTab, source], () => {
  commitSearchQuery()
  refreshSnapshot()
})

watch(query, () => {
  clearSearchTimer()
  searchTimer = setTimeout(() => {
    searchTimer = null
    appliedQuery.value = query.value
    refreshSnapshot()
  }, SEARCH_DEBOUNCE_MS)
})

onMounted(async () => {
  await me.whenSettled()
  if (!isAdmin(me.me)) {
    access.value = 'denied'
    return
  }
  access.value = 'ready'
  await load('snapshot')
})

onUnmounted(() => {
  mounted = false
  clearPollTimer()
  clearSearchTimer()
  abortRequest()
})
</script>

<template>
  <section class="admin-logs">
    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      Process logs are limited to operators.
    </UiEmptyState>

    <template v-else>
      <header class="logs-header">
        <div>
          <h1>Backend Logs</h1>
          <p class="logs-context">
            Current backend process. History resets when the process restarts. Participant and
            workflow container diagnostics are not included.
          </p>
          <p v-if="hasSuccessfulResponse" class="logs-summary">
            <span>{{ shownCount }} shown from {{ retainedCount }} retained ({{ formatBytes(retainedBytes) }})</span>
            <span v-if="bootId !== null" class="logs-boot">Boot {{ bootId }}</span>
          </p>
        </div>
        <div class="logs-actions">
          <UiButton v-if="live" variant="secondary" @click="pause">Pause live updates</UiButton>
          <UiButton v-else variant="secondary" @click="resume">Resume live updates</UiButton>
          <UiButton variant="ghost" :disabled="!hasSuccessfulResponse" @click="onClear">Clear</UiButton>
        </div>
      </header>

      <UiTabs v-model="levelTab" class="logs-tabs" :tabs="LEVEL_TABS" />
      <div class="logs-filters">
        <UiInput v-model="query" type="search" placeholder="Search logs…" aria-label="Search logs" />
        <UiSelect v-model="source" aria-label="Log source">
          <option value="">All sources</option>
          <option v-for="item in sources" :key="item" :value="item">{{ item }}</option>
        </UiSelect>
      </div>

      <UiEmptyState v-if="historyTruncated" tone="danger">
        Earlier matching entries are no longer retained.
      </UiEmptyState>
      <UiEmptyState v-if="error !== null" tone="danger">
        {{ error }}
        <UiButton v-if="!hasSuccessfulResponse" variant="ghost" size="tight" @click="refreshSnapshot">
          Retry
        </UiButton>
      </UiEmptyState>
      <UiEmptyState v-else-if="loading && !hasSuccessfulResponse">Loading logs…</UiEmptyState>

      <BackendLogTable
        v-if="hasSuccessfulResponse"
        :entries="entries"
        :follow="live"
      />
    </template>
  </section>
</template>

<style scoped>
.logs-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.logs-header h1,
.logs-context,
.logs-summary {
  margin: 0;
}

.logs-context,
.logs-summary {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}

.logs-actions,
.logs-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.logs-tabs {
  margin-bottom: var(--space-4);
}

.logs-filters {
  margin-bottom: var(--space-4);
}

.logs-filters :deep(.ui-input) {
  flex: 1 1 16rem;
}
</style>
