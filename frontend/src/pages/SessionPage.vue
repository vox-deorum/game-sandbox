<!--
  The live session page: it fetches the session row, connects the socket, and mounts the environment's
  renderer over the live stream. The renderer owns the game frame; this page owns the session chrome
  that works for every environment — the status strip, the pause/resume toggle, the stop button, the
  active-timeout display, the decision log, and the end-of-session card with the replay link and pin.

  The chrome is composed from small composables: useSessionSocket owns the socket and the state derived
  from its frames, useRendererMount owns the canvas, usePinning owns the pin toggle. Capabilities derive
  from identity and mode: the owner of a human session controls the human slots and gets a live
  sendAction; everyone else is a spectator (same renderer, no controls). Pause state reflects the
  backend echoes, never a local guess.

  An already-ended session is a historical view, not a live transport. It hydrates the final facts and
  the decision log from the stored recording and never opens a socket.
-->
<script setup lang="ts">
import type { StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  getEnvironments,
  getRecording,
  getSession,
  listRecordings,
  type SessionRow,
} from '../api/client.js'
import DecisionLog, { type DecisionEntry } from '../components/DecisionLog.vue'
import RunMetadata from '../components/RunMetadata.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { usePinning } from '../composables/usePinning.js'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useSessionSocket } from '../composables/useSessionSocket.js'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'
import { parseRecording } from '../replay/parse.js'
import { summarizeStates } from '../replay/summary.js'

const route = useRoute()
const me = useMe()
const id = String(route.params.id)

const row = ref<SessionRow | null>(null)
const meta = ref<EnvironmentMeta | null>(null)
const loadError = ref(false)
const hostEl = ref<HTMLElement | null>(null)
const decisions = ref<DecisionEntry[]>([])

const isOwner = computed(
  () => me.me?.user_id !== undefined && row.value?.user_id === me.me.user_id,
)
const controlledSlots = computed<string[]>(() =>
  isOwner.value && row.value?.mode === 'human' && status.value !== 'ended'
    ? (meta.value?.human_slots ?? [])
    : [],
)
const recordingId = computed(() => row.value?.recording_id ?? null)

// The renderer (shared with replay) forwards the owner's live input. The socket owns the chrome state
// and hands recording frames back here to draw and log. The two reference each other through stable
// functions, so declaration order does not matter at call time.
const { noRenderer, targetCanvasSize, mount: mountRenderer, render: renderState } = useRendererMount({
  host: hostEl,
  meta,
  controlledSlots,
  sendAction: sendInput,
})
const { connection, status, paused, endReason, finalResult, connect, togglePause, stop, send } =
  useSessionSocket(id, {
    onHeader: (header) => mountRenderer(header),
    onState: (state) => {
      renderState(state)
      decisions.value.push(toDecision(state))
    },
  })
const { pinned, busy: pinBusy, error: pinError, toggle: togglePin } = usePinning(recordingId)

function sendInput(slot: string, action: unknown): void {
  send({ kind: 'input', slot, action })
}

/** The per-tick decision-log row: the primary agent's action. Prefer the controlled slot, else the
 *  first agent (single-agent today; multi-agent slot selection is a later stage's concern). */
function toDecision(state: StepState): DecisionEntry {
  const slot = controlledSlots.value[0] ?? Object.keys(state.agents)[0]
  return { tick: state.tick, action: slot === undefined ? undefined : state.agents[slot]?.action }
}

// The decision log sits beside a portrait canvas (a column is left free) and below a landscape one.
const logBeside = computed(() => {
  const size = targetCanvasSize.value
  return size != null && size.height > size.width
})

const showActiveTimeout = computed(
  () => controlledSlots.value.length > 0 && status.value !== 'ended',
)

const statusLabel = computed(() => {
  if (paused.value) {
    return 'Paused'
  }
  return status.value === 'running' ? 'Live' : 'Starting…'
})
const statusTone = computed<'neutral' | 'success' | 'warning'>(() =>
  paused.value ? 'warning' : status.value === 'running' ? 'success' : 'neutral',
)

// One facts list feeds the terminal card, so live results and returned ended sessions stay aligned.
const metadataItems = computed(() => [
  { label: 'Environment', value: meta.value?.display_name ?? row.value?.env_id },
  { label: 'Environment ID', value: row.value?.env_id, code: true },
  { label: 'Session', value: row.value?.id, code: true },
  { label: 'Recording', value: recordingId.value, code: true },
  { label: 'Mode', value: row.value === null ? null : formatMode(row.value.mode) },
  { label: 'Reason', value: status.value === 'ended' ? reasonText(endReason.value) : null },
  { label: 'Final score', value: finalResult.value?.score },
  { label: 'Ticks', value: finalResult.value?.ticks },
  { label: 'Owner', value: row.value?.user_id },
  { label: 'Started', value: formatDate(row.value?.created_at) },
  { label: 'Ended', value: formatDate(row.value?.ended_at) },
  { label: 'Pinned', value: recordingId.value === null ? null : pinned.value ? 'Yes' : 'No' },
])

/** A friendly line for a termination reason, so a paused-and-idled session reads as normal, not error. */
function reasonText(reason: string | null): string {
  switch (reason) {
    case 'terminated':
      return 'Game over'
    case 'truncated':
    case 'episode_limit':
      return 'Episode complete'
    case 'stopped':
      return 'Stopped'
    case 'idle_timeout':
      return 'Ended after a period of inactivity'
    case 'time_limit':
      return 'Reached the time limit'
    case 'oom_killed':
      return 'Ended (out of memory)'
    case 'error':
      return 'Ended unexpectedly'
    default:
      return reason ?? 'Ended'
  }
}

/** The active-timeout readout: a paced game shows its per-step input window; an unpaced one its clock. */
const activeTimeoutLabel = computed(() => {
  const m = meta.value
  if (m === null) {
    return ''
  }
  if (m.pace_interval_ms !== null && m.pace_interval_ms > 0) {
    const perSecond = Math.round(1000 / m.pace_interval_ms)
    return `Per-step input window: ${m.pace_interval_ms} ms (${perSecond} steps/second)`
  }
  return m.human_timeout_ms !== null ? `Move time limit: ${m.human_timeout_ms} ms` : 'No move clock'
})

onMounted(async () => {
  const fetched = await getSession(id).catch(() => undefined)
  if (fetched === undefined) {
    loadError.value = true
    return
  }
  row.value = fetched
  status.value = fetched.status
  if (fetched.status === 'ended') {
    endReason.value = fetched.termination_reason
  }
  meta.value =
    (await getEnvironments().catch(() => [])).find((e) => e.env_id === fetched.env_id) ?? null
  if (meta.value === null) {
    noRenderer.value = true
  }

  // Identity must be resolved before the renderer mounts (attach replays the header immediately), or
  // the owner would be misjudged a spectator. The shared /api/me fetch is usually settled by now; this
  // awaits it rather than polling, closing the race.
  await me.whenSettled()

  if (fetched.status === 'ended') {
    // Historical sessions have no live socket to attach to; the recording is the source of truth.
    await hydrateRecording(fetched)
    connection.value = 'closed'
    return
  }
  connect()
})

async function hydrateRecording(session: SessionRow): Promise<void> {
  if (session.recording_id === null) {
    return
  }
  // Listing supplies retention facts such as pin state; the recording supplies the states.
  const [text, listing] = await Promise.all([
    getRecording(session.recording_id).catch(() => null),
    listRecordings({ env: session.env_id }).catch(() => []),
  ])
  const entry = listing.find((recording) => recording.id === session.recording_id)
  if (entry !== undefined) {
    pinned.value = entry.pinned
  }
  if (text === null) {
    return
  }
  try {
    const parsed = parseRecording(text)
    decisions.value = parsed.states.map(toDecision)
    mountRenderer(parsed.header)
    const finalState = parsed.states.at(-1)
    if (finalState !== undefined) {
      renderState(finalState)
    }
    if (finalResult.value === null) {
      finalResult.value = summarizeStates(parsed.states)
    }
  } catch {
    if (finalResult.value === null) {
      finalResult.value = { score: null, ticks: null }
    }
  }
}

function formatMode(mode: SessionRow['mode']): string {
  return mode === 'human' ? 'Human' : 'Scripted agent'
}
</script>

<template>
  <UiEmptyState v-if="loadError" tone="danger">No such session.</UiEmptyState>
  <section v-else class="session">
    <p class="context-line">
      <RouterLink to="/">Environments</RouterLink>
      <span aria-hidden="true"> / </span>
      <RouterLink v-if="row !== null" :to="`/environments/${row.env_id}`">
        {{ meta?.display_name ?? row.env_id }}
      </RouterLink>
      <span aria-hidden="true"> / </span>
      <span>{{ status === 'ended' ? 'Session' : 'Live session' }}</span>
    </p>

    <header v-if="status !== 'ended'" class="session-bar">
      <div class="session-status">
        <UiStatusBadge :tone="statusTone" :label="statusLabel" />
        <UiStatusBadge v-if="connection === 'reconnecting'" tone="warning" label="Reconnecting…" />
      </div>
      <div v-if="isOwner" class="session-controls">
        <UiButton variant="secondary" @click="togglePause">{{ paused ? 'Resume' : 'Pause' }}</UiButton>
        <UiButton variant="danger" @click="stop">Stop</UiButton>
      </div>
    </header>

    <p v-if="showActiveTimeout" class="active-timeout">{{ activeTimeoutLabel }}</p>

    <div class="stage" :class="logBeside ? 'beside' : 'below'">
      <div class="stage-canvas">
        <div class="renderer-host" ref="hostEl">
          <div v-if="paused && status !== 'ended'" class="overlay-banner">Paused</div>
        </div>
        <UiEmptyState v-if="noRenderer">No renderer is registered for this environment yet.</UiEmptyState>
      </div>

      <section v-if="logBeside" class="stage-log" aria-label="Decision log">
        <h2 class="stage-log-title">Decision log</h2>
        <DecisionLog :entries="decisions" />
      </section>
      <details v-else class="stage-log stage-log-below">
        <summary>Decision log</summary>
        <DecisionLog :entries="decisions" />
      </details>
    </div>

    <UiCard v-if="status === 'ended'" class="end-card">
      <h2 class="end-title">{{ reasonText(endReason) }}</h2>
      <RunMetadata :items="metadataItems" />
      <div class="end-actions">
        <UiButton v-if="recordingId !== null" :to="`/replays/${recordingId}`">Open replay</UiButton>
        <UiButton
          v-if="isOwner && recordingId !== null"
          variant="secondary"
          :loading="pinBusy"
          @click="togglePin"
        >
          {{ pinned ? 'Pinned ✓' : 'Pin this recording' }}
        </UiButton>
      </div>
      <UiEmptyState v-if="pinError !== null" tone="danger">{{ pinError }}</UiEmptyState>
    </UiCard>
  </section>
</template>

<style scoped>
.context-line {
  margin: 0 0 var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.context-line a:hover {
  color: var(--color-accent);
}

.session-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}

.session-status {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.session-controls {
  display: flex;
  gap: var(--space-2);
}

.active-timeout {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

/* The stage centers the canvas as the star; the log takes only the room the canvas leaves. */
.stage {
  display: grid;
  gap: var(--space-4);
}

.stage.beside {
  grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
  align-items: start;
}

.stage.below {
  grid-template-columns: minmax(0, 1fr);
  justify-items: center;
}

.renderer-host {
  position: relative;
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  background: var(--color-stage-backdrop);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.overlay-banner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--color-text);
  background: var(--color-scrim);
}

.stage-log-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
}

.stage-log :deep(.decision-log) {
  max-height: 480px;
}

.stage-log-below {
  width: 100%;
  max-width: 480px;
}

.stage-log-below summary {
  cursor: pointer;
  padding: var(--space-2) 0;
  font-family: var(--font-heading);
  font-size: var(--text-md);
}

.stage-log-below :deep(.decision-log) {
  max-height: 12rem;
}

.end-card {
  max-width: 480px;
  margin: var(--space-4) auto 0;
}

.end-title {
  margin-top: 0;
}

.end-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* On a narrow screen the stage stacks regardless of canvas shape. */
@media (max-width: 768px) {
  .stage.beside {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }
}
</style>
