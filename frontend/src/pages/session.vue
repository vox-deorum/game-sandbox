<!--
  The live session page: it fetches the session row, connects the socket, and mounts the environment's
  renderer over the live stream. The renderer owns the game frame; this page owns the session chrome
  that works for every environment — the status banner, the pause/resume toggle, the stop button, the
  active-timeout display, and the end-of-session card with the replay link and the pin stub.

  Capabilities derive from identity and mode, not separate flags: the owner of a human session controls
  the human slots and gets a live sendAction; the owner of a scripted session gets controls but no
  input; anyone else is a spectator (same renderer, no controls), which mirrors the protocol's
  owner-only authority rule. Pause state is never tracked locally — the UI reflects the pause/resume
  echoes the backend broadcasts, so it cannot disagree with the container.

  An already-ended session is a historical view, not a live transport. It hydrates the final facts
  from the stored recording and never opens a socket, which avoids reconnecting to a session the
  backend has already removed from the live registry.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  getEnvironments,
  getRecording,
  getSession,
  listRecordings,
  pinRecording,
  type SessionRow,
  unpinRecording,
} from '../api/client.js'
import { type ConnectionState, SessionSocket } from '../api/socket.js'
import RunMetadata from '../components/RunMetadata.vue'
import { useMe } from '../me.js'
import { getRenderer } from '../renderers/registry.js'
import type { RendererInstance } from '../renderers/types.js'
import { parseRecording } from '../replay/parse.js'
import { formatScoreMap, summarizeStates } from '../replay/summary.js'

const route = useRoute()
const me = useMe()
const id = String(route.params.id)

const row = ref<SessionRow | null>(null)
const meta = ref<EnvironmentMeta | null>(null)
const loadError = ref(false)
const noRenderer = ref(false)

const connection = ref<ConnectionState>('connecting')
const status = ref<'starting' | 'running' | 'ended'>('starting')
const paused = ref(false)
const endReason = ref<string | null>(null)
const finalResult = ref<{ score: string | null; ticks: number | null } | null>(null)

const pinned = ref(false)
const pinBusy = ref(false)
const pinError = ref<string | null>(null)

const hostEl = ref<HTMLElement | null>(null)
// shallowRef: these hold class instances we mutate imperatively, not reactive data.
const rendererInstance = shallowRef<RendererInstance | null>(null)
const socket = shallowRef<SessionSocket | null>(null)

const isOwner = computed(
  () => me.me?.user_id !== undefined && row.value?.user_id === me.me.user_id,
)
const controlledSlots = computed<string[]>(() =>
  isOwner.value && row.value?.mode === 'human' ? (meta.value?.human_slots ?? []) : [],
)
const showActiveTimeout = computed(() => controlledSlots.value.length > 0 && status.value !== 'ended')

const recordingId = computed(() => row.value?.recording_id ?? null)
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

const statusLabel = computed(() => {
  if (status.value === 'ended') {
    return 'Session ended'
  }
  if (paused.value) {
    return 'Paused'
  }
  return status.value === 'running' ? 'Live' : 'Starting…'
})

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

function mountRenderer(header: import('@game-sandbox/schema').RecordingHeader): void {
  // Attach replays the header on every (re)connect; mount only the first time.
  if (rendererInstance.value !== null || meta.value === null || hostEl.value === null) {
    return
  }
  const module = getRenderer(meta.value.renderer)
  if (module === undefined) {
    noRenderer.value = true
    return
  }
  const slots = controlledSlots.value
  rendererInstance.value = module.mount({
    container: hostEl.value,
    meta: meta.value,
    header,
    controlledSlots: slots,
    sendAction:
      slots.length > 0
        ? (slot, action) => socket.value?.send({ kind: 'input', slot, action })
        : undefined,
  })
}

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
  meta.value = (await getEnvironments().catch(() => [])).find((e) => e.env_id === fetched.env_id) ?? null

  // Identity must be resolved before the renderer mounts (attach replays the header immediately), or
  // the owner would be misjudged a spectator and get a draw-only renderer with no input. The shared
  // /api/me fetch is usually settled by now; this bounded wait closes the race. `loading` clears on
  // both success and error, so the loop always terminates quickly.
  for (let i = 0; i < 200 && me.loading; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  if (fetched.status === 'ended') {
    // Historical sessions have no live socket to attach to; the recording is the source of truth.
    await hydrateRecordingMetadata(fetched)
    connection.value = 'closed'
    return
  }

  const client = new SessionSocket(`/api/sessions/${id}/ws`, {
    onHeader: (header) => mountRenderer(header),
    onState: (state) => rendererInstance.value?.render(state),
    onSessionStatus: (next, reason) => {
      status.value = next
      if (next === 'ended') {
        endReason.value = reason ?? endReason.value
      }
    },
    onPause: () => {
      paused.value = true
    },
    onResume: () => {
      paused.value = false
    },
    onResult: (value) => {
      const scores = (value.scores ?? {}) as Record<string, number>
      finalResult.value = {
        score: formatScoreMap(scores),
        ticks: typeof value.ticks === 'number' ? value.ticks : null,
      }
      if (typeof value.reason === 'string') {
        endReason.value = value.reason
      }
    },
    onConnectionChange: (state) => {
      connection.value = state
    },
  })
  socket.value = client
  client.connect()
})

onBeforeUnmount(() => {
  rendererInstance.value?.destroy()
  rendererInstance.value = null
  socket.value?.close()
  socket.value = null
})

function togglePause(): void {
  socket.value?.send({ kind: paused.value ? 'resume' : 'pause' })
}

function stop(): void {
  // Graceful in-band stop; the container flushes its recording and exits.
  socket.value?.send({ kind: 'stop' })
}

async function togglePin(): Promise<void> {
  if (recordingId.value === null || pinBusy.value) {
    return
  }
  pinBusy.value = true
  pinError.value = null
  const result = pinned.value
    ? await unpinRecording(recordingId.value)
    : await pinRecording(recordingId.value)
  if (result.ok) {
    pinned.value = !pinned.value
  } else if (result.reason === 'pinned_quota') {
    pinError.value = 'You have reached your pinned-recording limit. Unpin an older one first.'
  } else {
    pinError.value = 'Could not update the pin.'
  }
  pinBusy.value = false
}

async function hydrateRecordingMetadata(session: SessionRow): Promise<void> {
  if (session.recording_id === null) {
    return
  }
  // Listing supplies retention facts such as pin state; the recording supplies final score/ticks.
  const [text, listing] = await Promise.all([
    getRecording(session.recording_id).catch(() => null),
    listRecordings({ env: session.env_id }).catch(() => []),
  ])
  const entry = listing.find((recording) => recording.id === session.recording_id)
  if (entry !== undefined) {
    pinned.value = entry.pinned
  }
  if (text === null || finalResult.value !== null) {
    return
  }
  try {
    finalResult.value = summarizeStates(parseRecording(text).states)
  } catch {
    finalResult.value = { score: null, ticks: null }
  }
}

function formatMode(mode: SessionRow['mode']): string {
  return mode === 'human' ? 'Human' : 'Scripted agent'
}

function formatDate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}
</script>

<template>
  <p v-if="loadError" class="status">No such session.</p>
  <section v-else class="session">
    <header class="session-bar">
      <div class="session-status">
        <span class="status-dot" :class="status" />
        <strong>{{ statusLabel }}</strong>
        <span v-if="connection === 'reconnecting'" class="status reconnecting">Reconnecting…</span>
      </div>
      <div v-if="isOwner && status !== 'ended'" class="session-controls">
        <button type="button" @click="togglePause">{{ paused ? 'Resume' : 'Pause' }}</button>
        <button type="button" class="secondary" @click="stop">Stop</button>
      </div>
    </header>

    <p v-if="showActiveTimeout" class="active-timeout">{{ activeTimeoutLabel }}</p>

    <div class="renderer-host" ref="hostEl">
      <div v-if="paused && status !== 'ended'" class="overlay-banner">Paused</div>
    </div>
    <p v-if="noRenderer" class="status">No renderer is registered for this environment yet.</p>

    <div v-if="status === 'ended'" class="end-card">
      <h2>{{ reasonText(endReason) }}</h2>
      <RunMetadata :items="metadataItems" />
      <div class="end-actions">
        <RouterLink v-if="recordingId !== null" class="button-link" :to="`/replays/${recordingId}`">
          Open replay
        </RouterLink>
        <button v-if="isOwner && recordingId !== null" type="button" @click="togglePin" :disabled="pinBusy">
          {{ pinned ? 'Pinned ✓' : 'Pin this recording' }}
        </button>
      </div>
      <p v-if="pinError !== null" class="error">{{ pinError }}</p>
    </div>
  </section>
</template>
