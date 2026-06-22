<!--
  The live session page: it fetches the session row, connects the socket, and mounts the environment's
  renderer over the live stream. The renderer owns the game frame; this page owns the session chrome
  that works for every environment — the status strip, the pause/resume toggle, the stop button, the
  decision log, and the end-of-session card with the replay link and pin.

  The chrome is composed from small composables: useSessionSocket owns the socket and the state derived
  from its frames, useRendererMount owns the canvas, usePinning owns the pin toggle. Capabilities derive
  from identity and mode: the owner of a human session controls the human slots and gets a live
  sendAction; everyone else is a spectator (same renderer, no controls). Pause state reflects the
  backend echoes, never a local guess.

  An already-ended session is a historical view, not a live transport. It hydrates the final facts and
  the decision log from the stored recording and never opens a socket.
-->
<script setup lang="ts">
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  getEnvironments,
  getRecording,
  getSession,
  listSeasons,
  listRecordings,
  type SessionRow,
} from '../api/client.js'
import DecisionLog, { type DecisionEntry } from '../components/DecisionLog.vue'
import ExperimentTabs from '../components/ExperimentTabs.vue'
import PlayerAttribution from '../components/PlayerAttribution.vue'
import RunMetadata from '../components/RunMetadata.vue'
import SessionRatings from '../components/SessionRatings.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { usePinning } from '../composables/usePinning.js'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useSessionSocket } from '../composables/useSessionSocket.js'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'
import { parseRecording } from '../replay/parse.js'
import { reasonText } from '../replay/reason.js'
import { summarizeStates } from '../replay/summary.js'

const route = useRoute()
const me = useMe()
const id = String(route.params.id)

const row = ref<SessionRow | null>(null)
const meta = ref<EnvironmentMeta | null>(null)
const loadError = ref(false)
const hostEl = ref<HTMLElement | null>(null)
const decisions = ref<DecisionEntry[]>([])
const seasonPlayable = ref(false)
// The recording header carries per-slot attribution (`players`); retained to show who played.
const header = ref<RecordingHeader | null>(null)

const isOwner = computed(
  () => me.me?.user_id !== undefined && row.value?.user_id === me.me.user_id,
)
const controlledSlots = computed<string[]>(() =>
  isOwner.value && row.value?.mode === 'human' && status.value !== 'ended'
    ? (meta.value?.human_slots ?? [])
    : [],
)
const recordingId = computed(() => row.value?.recording_id ?? null)
// Fail closed: anyone not confirmed an operator (including an unresolved identity) sees the blind
// attribution while the season is playable.
const blindAttribution = computed(
  () => seasonPlayable.value && me.me?.is_operator !== true,
)

// The renderer (shared with replay) forwards the owner's live input. The socket owns the chrome state
// and hands recording frames back here to draw and log. The two reference each other through stable
// functions, so declaration order does not matter at call time.
const { noRenderer, aspectRatio, mount: mountRenderer, render: renderState } = useRendererMount({
  host: hostEl,
  meta,
  controlledSlots,
  sendAction: sendInput,
})
const {
  connection,
  status,
  paused,
  buffering,
  endReason,
  finalResult,
  connect,
  togglePause,
  stop,
  send,
} = useSessionSocket(id, {
    onHeader: (incoming) => {
      header.value = incoming
      mountRenderer(incoming)
    },
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
  return {
    tick: state.tick,
    slot: slot ?? '',
    action: slot === undefined ? undefined : state.agents[slot]?.action,
  }
}

// The decision log sits beside a portrait canvas (a column is left free) and below a landscape one.
const logBeside = computed(() => aspectRatio.value !== null && aspectRatio.value < 1)

const statusLabel = computed(() => {
  if (status.value === 'ended') {
    return reasonText(endReason.value)
  }
  if (paused.value) {
    return 'Paused'
  }
  return status.value === 'running' ? 'Live' : 'Starting…'
})
const statusTone = computed<'neutral' | 'success' | 'warning'>(() => {
  if (status.value === 'ended') {
    return 'neutral'
  }
  return paused.value ? 'warning' : status.value === 'running' ? 'success' : 'neutral'
})

// The run's own facts, shown inline in the status row beside the badge. The tabs name the environment,
// the status badge names the end reason, and the pin button shows pin state — so the strip carries only
// score, ticks, and start time. Score and ticks resolve only once a session ends, so RunMetadata's
// drop-empties rule keeps a live session's row to just the start time.
const statusFacts = computed(() => [
  { label: 'Score', value: finalResult.value?.score },
  { label: 'Ticks', value: finalResult.value?.ticks },
  { label: 'Started', value: formatDate(row.value?.created_at) },
])

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
  const [environments, seasons] = await Promise.all([
    getEnvironments().catch(() => []),
    listSeasons(fetched.env_id).catch(() => []),
  ])
  meta.value = environments.find((e) => e.env_id === fetched.env_id) ?? null
  seasonPlayable.value =
    fetched.season_id !== null &&
    seasons.some((season) => season.id === fetched.season_id && season.play_status === 'open')
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
  // A watch run (scripted) plays paced so a container that streams faster than real time still
  // animates at the environment's cadence and reveals game over only once the frames have played
  // out. A human session renders every frame on arrival, for immediate feedback to the owner's input.
  connect({ pace: fetched.mode === 'scripted', paceMs: meta.value?.pace_interval_ms ?? null })
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
    header.value = parsed.header
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
</script>

<template>
  <UiEmptyState v-if="loadError" tone="danger">No such session.</UiEmptyState>
  <section v-else class="session">
    <ExperimentTabs v-if="row !== null" class="session-tabs" :env-id="row.env_id" />

    <header class="session-bar">
      <div class="session-status">
        <UiStatusBadge :tone="statusTone" :label="statusLabel" />
        <UiStatusBadge
          v-if="connection === 'reconnecting' && status !== 'ended'"
          tone="warning"
          label="Reconnecting…"
        />
        <RunMetadata class="status-facts" :items="statusFacts" />
      </div>
      <div
        v-if="status === 'ended' ? recordingId !== null : isOwner"
        class="session-controls"
      >
        <template v-if="status === 'ended'">
          <UiButton v-if="recordingId !== null" size="tight" :to="`/replays/${recordingId}`">Open replay</UiButton>
          <UiButton
            v-if="isOwner && recordingId !== null"
            variant="secondary"
            size="tight"
            :loading="pinBusy"
            @click="togglePin"
          >
            {{ pinned ? 'Pinned ✓' : 'Pin this recording' }}
          </UiButton>
        </template>
        <template v-else>
          <UiButton variant="secondary" size="tight" @click="togglePause">{{ paused ? 'Resume' : 'Pause' }}</UiButton>
          <UiButton variant="danger" size="tight" @click="stop">Stop</UiButton>
        </template>
      </div>
    </header>

    <UiEmptyState v-if="status === 'ended' && pinError !== null" tone="danger">
      {{ pinError }}
    </UiEmptyState>

    <PlayerAttribution
      :players="header?.players"
      :blind="blindAttribution"
      :viewer-id="me.me?.user_id"
    />

    <!-- End-of-session feedback appears only after termination, immediately above the game stage. -->
    <SessionRatings v-if="status === 'ended'" :session-id="id" />

    <div class="stage" :class="logBeside ? 'beside' : 'below'">
      <section class="stage-canvas" aria-label="Environment">
        <div
          class="renderer-host"
          ref="hostEl"
          :style="aspectRatio !== null ? { aspectRatio: String(aspectRatio) } : undefined"
        >
          <div v-if="paused && status !== 'ended'" class="overlay-banner">Paused</div>
          <div
            v-else-if="buffering && status !== 'ended'"
            class="overlay-banner overlay-banner--waiting"
            role="status"
          >
            <span class="overlay-spinner" aria-hidden="true" />
            <span>Waiting…</span>
          </div>
        </div>
        <UiEmptyState v-if="noRenderer">No renderer is registered for this environment yet.</UiEmptyState>
      </section>

      <section v-if="logBeside" class="stage-log" aria-label="Decision log">
        <div class="stage-log-body">
          <DecisionLog :entries="decisions" />
        </div>
      </section>
      <details v-else class="stage-log stage-log-below">
        <summary>Decision log</summary>
        <DecisionLog :entries="decisions" />
      </details>
    </div>

  </section>
</template>

<style scoped>
/* The shared tab strip carries its own full-width border and an inner max-width/padding that the shell
   normally aligns to the page edges. Inside the padded page content we bleed it back out by the page
   padding so its border spans the content width and its inner labels line up with the page below. */
.session-tabs {
  margin: calc(var(--space-5) * -1) calc(var(--space-5) * -1) var(--space-4);
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
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
}

/* The run facts sit inline beside the status badge, so the bar stays one row about button height; drop
   RunMetadata's own bottom margin that would otherwise break the row's vertical centering. (The class
   lands on RunMetadata's root, which carries this scope id, so no :deep is needed.) */
.status-facts {
  margin: 0;
}

.session-controls {
  display: flex;
  gap: var(--space-1);
}

/* The stage centers the canvas as the star; the log takes only the room the canvas leaves. */
.stage {
  display: grid;
  gap: var(--space-4);
}

/* Beside layout: the columns stretch to a common height so the log matches the canvas to its left. */
.stage.beside {
  grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
  align-items: stretch;
}

.stage.beside .stage-canvas,
.stage.beside .stage-log {
  display: flex;
  flex-direction: column;
  min-height: 0;
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

/* The buffer-underrun indicator: a spinner over the held frame while the next frames are awaited. */
.overlay-banner--waiting {
  flex-direction: column;
  gap: var(--space-3);
  font-size: var(--text-md);
  letter-spacing: 0.05em;
}

.overlay-spinner {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-accent);
  animation: overlay-spin 0.8s linear infinite;
}

@keyframes overlay-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .overlay-spinner {
    animation: none;
  }
}

/* The log fills the height the canvas defines and scrolls within it. The body is positioned so its
   table never contributes to the row height — otherwise a long log would stretch the row past the
   canvas; instead the canvas defines the height and the log scrolls inside it. */
.stage.beside .stage-log-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.stage.beside .stage-log-body :deep(.decision-log) {
  position: absolute;
  inset: 0;
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

/* On a narrow screen the stage stacks regardless of canvas shape. */
@media (max-width: 768px) {
  .stage.beside {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }
}
</style>
