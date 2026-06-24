<!--
  The operator run-details page: one run's scheduled games and its container logs, split out of the
  admin console so the console stays a control surface. It is the single owner of a run's live stream —
  opening a still-executing run (pending/running) attaches to the step-3 log WebSocket and tails its
  lines and per-game status transitions; opening a settled run just renders the persisted snapshot with
  no socket. On the terminal event the page reloads so the freshly persisted statuses replace the live
  overlay. Like the console it self-gates on `me.is_operator`; the backend admin guard is the authority.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { getRun, type GameStatus, type RunView, runLogWsPath } from '../api/client.js'
import { RunLogSocket } from '../api/runLogSocket.js'
import GamesTable from '../components/admin/GamesTable.vue'
import type { RunLogLine } from '../components/admin/RunLogTable.vue'
import RunLogTable from '../components/admin/RunLogTable.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'

const route = useRoute()
const me = useMe()
const envId = String(route.params.envId)
const seasonId = String(route.params.seasonId)
const runId = String(route.params.runId)

type Access = 'loading' | 'denied' | 'ready'
const access = ref<Access>('loading')

type LoadState = 'loading' | 'loaded' | 'error'
const loadState = ref<LoadState>('loading')
const run = ref<RunView | null>(null)

// Live per-game status overlay keyed by game_index, and the live log buffer; both fed by the socket
// while the run executes. Capped so a long run cannot grow the buffer without bound.
const liveStatus = ref<Record<number, GameStatus>>({})
const logLines = ref<RunLogLine[]>([])
const LOG_CAP = 1_000

let socket: RunLogSocket | null = null
// Set once the component is torn down, so a getRun() still in flight cannot open a socket or mutate
// refs after unmount — a quick back-navigation during the initial load (or a terminal reload) would
// otherwise leak a live stream behind a gone component.
let disposed = false

const STATUS_TONE: Record<RunView['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral',
  running: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

const inProgress = computed(
  () => run.value?.status === 'pending' || run.value?.status === 'running',
)

function disconnect(): void {
  socket?.close()
  socket = null
}

/** Open the live stream for an in-progress run. */
function connect(): void {
  disconnect()
  socket = new RunLogSocket(runLogWsPath(seasonId, runId), {
    onLog: (event) => {
      logLines.value.push({
        match_index: event.match_index,
        game_index: event.game_index,
        ts: event.ts,
        level: event.level,
        line: event.line,
      })
      if (logLines.value.length > LOG_CAP) {
        logLines.value.splice(0, logLines.value.length - LOG_CAP)
      }
    },
    onGameStatus: (event) => {
      liveStatus.value = { ...liveStatus.value, [event.game_index]: event.status }
    },
    onTerminal: () => {
      // The run settled; reload so the persisted statuses replace the live overlay. The backend
      // closes the socket after the terminal event.
      void load()
    },
    onClose: () => {
      socket = null
    },
  })
  socket.connect()
}

async function load(): Promise<void> {
  loadState.value = 'loading'
  try {
    const loaded = await getRun(seasonId, runId)
    if (disposed) {
      return
    }
    run.value = loaded
    loadState.value = 'loaded'
    // Only an executing run has a live stream behind it; a settled run renders persisted data.
    if (loaded.status === 'pending' || loaded.status === 'running') {
      connect()
    } else {
      disconnect()
    }
  } catch {
    if (disposed) {
      return
    }
    loadState.value = 'error'
    disconnect()
  }
}

onMounted(async () => {
  await me.whenSettled()
  if (disposed) {
    return
  }
  if (!me.me?.is_operator) {
    access.value = 'denied'
    return
  }
  access.value = 'ready'
  await load()
})

onUnmounted(() => {
  disposed = true
  disconnect()
})
</script>

<template>
  <section class="run-details">
    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      The admin console is limited to operators.
    </UiEmptyState>

    <template v-else>
      <p class="back">
        <RouterLink :to="`/environments/${envId}/admin`">← Back to console</RouterLink>
      </p>

      <UiEmptyState v-if="loadState === 'loading'">Loading run…</UiEmptyState>
      <UiEmptyState v-else-if="loadState === 'error' || run === null" tone="danger">
        That run could not be found.
      </UiEmptyState>

      <template v-else>
        <header class="run-header">
          <h1>Run Details</h1>
          <UiStatusBadge :tone="STATUS_TONE[run.status]" :label="`${run.status}`" />
        </header>

        <dl class="run-meta">
          <div><dt>Requested by</dt><dd>{{ run.requested_by }}</dd></div>
          <div><dt>Started</dt><dd>{{ formatDate(run.started_at) ?? '—' }}</dd></div>
          <div><dt>Ended</dt><dd>{{ formatDate(run.ended_at) ?? '—' }}</dd></div>
        </dl>
        <p v-if="run.error" class="run-error" role="alert">{{ run.error }}</p>

        <section class="run-section">
          <h2>Games</h2>
          <GamesTable :games="run.games" :live-status="liveStatus" />
        </section>

        <section class="run-section">
          <h2>Container Logs</h2>
          <RunLogTable :lines="logLines" />
          <p v-if="!inProgress && logLines.length === 0" class="hint">
            No live logs (the run is not in progress).
          </p>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.back {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
}

.run-header {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.run-header h1 {
  margin: 0;
}

.run-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
  margin: 0 0 var(--space-4);
}

.run-meta div {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.run-meta dt {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.run-meta dd {
  margin: 0;
  font-size: var(--text-sm);
}

.run-error {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.run-section {
  margin-top: var(--space-5);
}

.run-section h2 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-lg);
}

.hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
