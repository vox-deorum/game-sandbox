<!--
  The run controls and live log view of the operator console (Stage 6.7). It triggers and re-runs the
  workflow, cancels an in-flight run, and renders the run's progress: the per-match container log lines
  and per-game status as they arrive over the step-3 WebSocket log stream.

  Opening the console mid-run shows current progress from the persisted per-game statuses (read with
  the admin status view and passed in as `latestRun`), then tails the live log lines from the socket.
  The stream is live-only — the buffered backlog-on-attach is deferred — so earlier lines are not
  replayed. A `409 run_in_progress` surfaces as "a run is already in progress"; a `409 empty_schedule`
  points back at the match design. After a run reaches a terminal state the console reloads, so the
  freshly computed boards appear (operator-only until the iteration is released).
-->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

import {
  cancelRun,
  type GameStatus,
  type IterationView,
  type RunView,
  runLogWsPath,
  triggerRun,
} from '../../api/client.js'
import { RunLogSocket } from '../../api/runLogSocket.js'
import UiButton from '../ui/UiButton.vue'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

const props = defineProps<{ iteration: IterationView; latestRun: RunView | null }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const triggering = ref(false)
const cancelling = ref(false)
const error = ref<string | null>(null)
const logLines = ref<string[]>([])
// Live per-game status overlay, keyed by game_index, seeded from the persisted run and updated by the
// stream's game_status events.
const liveStatus = ref<Record<number, GameStatus>>({})

const LOG_CAP = 1_000

let socket: RunLogSocket | null = null
let streamingRunId: string | null = null

/** Whether the latest run is still executing, so a re-run is refused and a cancel is offered. */
const inProgress = computed(
  () => props.latestRun?.status === 'pending' || props.latestRun?.status === 'running',
)

const triggerLabel = computed(() => (props.latestRun === null ? 'Run workflow' : 'Re-run workflow'))

const STATUS_TONE: Record<GameStatus | RunView['status'], 'neutral' | 'success' | 'danger' | 'warning'> =
  {
    pending: 'neutral',
    running: 'warning',
    completed: 'success',
    failed: 'danger',
    timed_out: 'danger',
    cancelled: 'neutral',
  }

/** The effective status of a game: the live overlay if present, else the persisted status. */
function gameStatus(gameIndex: number, persisted: GameStatus): GameStatus {
  return liveStatus.value[gameIndex] ?? persisted
}

function disconnect(): void {
  socket?.close()
  socket = null
  streamingRunId = null
}

/** Open the live stream for the in-progress run, replacing any prior subscription. */
function connect(run: RunView): void {
  if (streamingRunId === run.id) {
    return
  }
  disconnect()
  streamingRunId = run.id
  socket = new RunLogSocket(runLogWsPath(props.iteration.id, run.id), {
    onLog: (event) => {
      logLines.value.push(`[m${event.match_index}/g${event.game_index}] ${event.line}`)
      if (logLines.value.length > LOG_CAP) {
        logLines.value.splice(0, logLines.value.length - LOG_CAP)
      }
    },
    onGameStatus: (event) => {
      liveStatus.value = { ...liveStatus.value, [event.game_index]: event.status }
    },
    onTerminal: () => {
      // The run settled; reload so the persisted statuses and freshly computed boards replace the live
      // overlay. The backend closes the socket after the terminal event.
      emit('changed')
    },
    onClose: () => {
      socket = null
      streamingRunId = null
    },
  })
  socket.connect()
}

// Seed the per-game overlay from the persisted run and (dis)connect the stream as the run moves in and
// out of progress. Runs immediately so opening mid-run attaches to the live tail.
watch(
  () => props.latestRun,
  (run) => {
    liveStatus.value = {}
    if (run !== null && inProgress.value) {
      connect(run)
    } else {
      disconnect()
    }
  },
  { immediate: true, deep: false },
)

onUnmounted(disconnect)

async function trigger(): Promise<void> {
  triggering.value = true
  error.value = null
  const result = await triggerRun(props.iteration.id)
  triggering.value = false
  if (result.ok) {
    logLines.value = []
    liveStatus.value = {}
    emit('changed')
    return
  }
  if (result.reason === 'run_in_progress') {
    error.value = 'A run is already in progress for this iteration.'
  } else if (result.reason === 'empty_schedule') {
    error.value =
      'This iteration resolves to an empty schedule. Add at least one match in the match design before running.'
  } else {
    error.value = 'Could not start the run. Please try again.'
  }
}

async function cancel(): Promise<void> {
  if (props.latestRun === null) {
    return
  }
  cancelling.value = true
  error.value = null
  const result = await cancelRun(props.iteration.id, props.latestRun.id)
  cancelling.value = false
  if (result.ok) {
    emit('changed')
    return
  }
  error.value =
    result.reason === 'run_not_in_progress'
      ? 'That run is no longer in progress.'
      : 'Could not cancel the run.'
}
</script>

<template>
  <div class="run-panel">
    <div class="run-actions">
      <UiButton :loading="triggering" :disabled="inProgress" @click="trigger">
        {{ triggerLabel }}
      </UiButton>
      <UiButton v-if="inProgress" variant="danger" :loading="cancelling" @click="cancel">
        Cancel run
      </UiButton>
      <UiStatusBadge
        v-if="latestRun !== null"
        :tone="STATUS_TONE[latestRun.status]"
        :label="`Run ${latestRun.status}`"
      />
    </div>

    <p v-if="error" class="run-error" role="alert">{{ error }}</p>
    <p v-if="latestRun?.error" class="run-error">{{ latestRun.error }}</p>

    <template v-if="latestRun !== null">
      <h4 class="run-subtitle">Games</h4>
      <ul class="game-list">
        <li v-for="game in latestRun.games" :key="game.id" class="game-row" data-testid="game-row">
          <span class="game-id">m{{ game.match_index }} · g{{ game.game_index }} · seed {{ game.seed }}</span>
          <UiStatusBadge
            :tone="STATUS_TONE[gameStatus(game.game_index, game.status)]"
            :label="gameStatus(game.game_index, game.status)"
          />
        </li>
      </ul>

      <h4 class="run-subtitle">Container logs</h4>
      <pre v-if="logLines.length > 0" class="log-view" data-testid="log-view">{{ logLines.join('\n') }}</pre>
      <p v-else class="run-hint">
        {{ inProgress ? 'Waiting for log lines…' : 'No live logs (the run is not in progress).' }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.run-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.run-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.run-subtitle {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.game-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.game-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--text-sm);
}

.game-id {
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.log-view {
  margin: 0;
  max-height: 18rem;
  overflow: auto;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}

.run-hint {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
