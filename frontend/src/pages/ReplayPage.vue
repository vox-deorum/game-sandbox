<!--
  The replay viewer: load a recording by URL, then play, pause, step, and scrub it through the same
  renderer live play uses, sharing the session page's pieces (the renderer mount, the decision log, the
  run metadata, and the pin toggle). The recording is fetched as JSONL and parsed in the browser (the
  schema package's Ajv reader is Node-only); a header version this viewer does not understand becomes a
  friendly "needs a newer viewer" message.

  The viewer is draw-only by construction: the renderer mounts with no sendAction and no controlled
  slots. The transport is fully keyboard operable from the stage region (space toggles play, the arrows
  step, Home and End jump), and the scrubber exposes its position to assistive tech. The decision log
  replays from the same recorded states the transport walks, staying in sync with the scrubber.
-->
<script setup lang="ts">
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  getEnvironments,
  getRecording,
  listRecordings,
  type RecordingSummary,
} from '../api/client.js'
import DecisionLog, { type DecisionEntry } from '../components/DecisionLog.vue'
import PlayerAttribution from '../components/PlayerAttribution.vue'
import RunMetadata from '../components/RunMetadata.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiSlider from '../components/ui/UiSlider.vue'
import { usePinning } from '../composables/usePinning.js'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useReplayTransport } from '../composables/useReplayTransport.js'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'
import { parseRecording, UnsupportedVersionError } from '../replay/parse.js'
import { type RunSummary, summarizeStates } from '../replay/summary.js'

const route = useRoute()
const me = useMe()
const id = String(route.params.id)

const loading = ref(true)
const loadError = ref(false)
const versionMessage = ref<string | null>(null)
const header = ref<RecordingHeader | null>(null)
const meta = ref<EnvironmentMeta | null>(null)
const finalSummary = ref<RunSummary>({ score: null, ticks: null })
const listingEntry = ref<RecordingSummary | null>(null)
const owned = ref(false)
const decisions = ref<DecisionEntry[]>([])

const hostEl = ref<HTMLElement | null>(null)

const { noRenderer, aspectRatio, mount: mountRenderer, render: renderState } = useRendererMount({
  host: hostEl,
  meta,
})
const { state: replayState, transport, init: initTransport, onKeydown } = useReplayTransport()
const { pinned, busy: pinBusy, error: pinError, toggle: togglePin } = usePinning(id)

// The decision log sits beside a portrait canvas and below a landscape one (the same rule as live).
const logBeside = computed(() => aspectRatio.value !== null && aspectRatio.value < 1)

// The scrubber's value is the transport index; setting it (drag or keyboard) seeks the transport.
const scrubIndex = computed({
  get: () => replayState.value.index,
  set: (i) => transport.value?.seek(i),
})

// Keep replay facts in the same shape as the ended-session card. The environment and recording id
// already sit in the context line and URL, and pin state is shown by the pin button — so the strip
// carries only the run's own facts, not those echoes.
const metadataItems = computed(() => [
  { label: 'Seed', value: header.value?.seed },
  { label: 'Final score', value: finalSummary.value.score },
  { label: 'Ticks', value: finalSummary.value.ticks },
  { label: 'Owner', value: listingEntry.value?.user_id },
  { label: 'Created', value: formatDate(listingEntry.value?.created_at) },
])

/** One decision-log row per state: the first agent's action (single-agent today). */
function toDecision(state: StepState): DecisionEntry {
  const slot = Object.keys(state.agents)[0]
  return {
    tick: state.tick,
    slot: slot ?? '',
    action: slot === undefined ? undefined : state.agents[slot]?.action,
  }
}

onMounted(async () => {
  let text: string
  try {
    text = await getRecording(id)
  } catch {
    loadError.value = true
    loading.value = false
    return
  }

  let parsed: ReturnType<typeof parseRecording>
  try {
    parsed = parseRecording(text)
  } catch (error) {
    if (error instanceof UnsupportedVersionError) {
      versionMessage.value = error.message
    } else {
      loadError.value = true
    }
    loading.value = false
    return
  }
  header.value = parsed.header
  // The live result envelope is not part of the JSONL recording, so summarize the final state.
  finalSummary.value = summarizeStates(parsed.states)
  decisions.value = parsed.states.map(toDecision)
  loading.value = false

  meta.value =
    (await getEnvironments().catch(() => [])).find((e) => e.env_id === parsed.header.environment) ??
    null
  if (meta.value === null) {
    noRenderer.value = true
  } else {
    mountRenderer(parsed.header)
  }

  initTransport(parsed.states, {
    paceIntervalMs: meta.value?.pace_interval_ms ?? null,
    onFrame: (state) => renderState(state),
  })

  // A `?t=⟨tick⟩` deep link seeks on load, so a moment inside a replay is linkable, not just the replay.
  const tParam = Number(route.query.t)
  if (route.query.t !== undefined && Number.isFinite(tParam)) {
    transport.value?.seekToTick(tParam)
  } else {
    transport.value?.renderCurrent()
  }

  // Determine ownership and the current pin state from the merged listing.
  await me.whenSettled()
  const listing = await listRecordings({ env: parsed.header.environment }).catch(() => [])
  const entry = listing.find((r) => r.id === id)
  listingEntry.value = entry ?? null
  if (entry !== undefined && me.me?.user_id !== undefined && entry.user_id === me.me.user_id) {
    owned.value = true
    pinned.value = entry.pinned
  }
})
</script>

<template>
  <UiEmptyState v-if="loading">Loading replay…</UiEmptyState>
  <UiEmptyState v-else-if="loadError" tone="danger">Could not load this replay.</UiEmptyState>
  <UiEmptyState v-else-if="versionMessage !== null">
    This replay needs a newer viewer. {{ versionMessage }}
  </UiEmptyState>
  <section v-else class="replay">
    <div class="context-row">
      <p class="context-line">
        <RouterLink to="/">Environments</RouterLink>
        <span aria-hidden="true"> / </span>
        <RouterLink v-if="header !== null" :to="`/environments/${header.environment}`">
          {{ meta?.display_name ?? header.environment }}
        </RouterLink>
        <span aria-hidden="true"> / </span>
        <span>Replay</span>
      </p>
      <UiButton
        v-if="owned"
        class="context-pin"
        variant="secondary"
        :loading="pinBusy"
        @click="togglePin"
      >
        {{ pinned ? 'Pinned ✓' : 'Pin this recording' }}
      </UiButton>
    </div>
    <UiEmptyState v-if="owned && pinError !== null" tone="danger">{{ pinError }}</UiEmptyState>

    <RunMetadata :items="metadataItems" />
    <PlayerAttribution :players="header?.players" />

    <div v-if="transport !== null" class="replay-controls">
      <UiButton variant="secondary" :disabled="replayState.index === 0" @click="transport?.stepBack()">
        Step back
      </UiButton>
      <UiButton @click="transport?.toggle()">{{ replayState.playing ? 'Pause' : 'Play' }}</UiButton>
      <UiButton
        variant="secondary"
        :disabled="replayState.index >= replayState.total - 1"
        @click="transport?.stepForward()"
      >
        Step forward
      </UiButton>
      <div class="scrubber">
        <UiSlider v-model="scrubIndex" :max="Math.max(0, replayState.total - 1)" label="Replay position" />
      </div>
      <span class="replay-position">
        tick {{ replayState.tick ?? 0 }} · {{ replayState.index + 1 }}/{{ replayState.total }}
      </span>
    </div>

    <div
      class="stage"
      :class="logBeside ? 'beside' : 'below'"
      tabindex="0"
      role="group"
      aria-label="Replay stage"
      @keydown="onKeydown"
    >
      <section class="stage-canvas" aria-label="Replay">
        <h2 class="stage-title">{{ meta?.display_name ?? header?.environment ?? 'Replay' }}</h2>
        <div
          class="renderer-host"
          ref="hostEl"
          :style="aspectRatio !== null ? { aspectRatio: String(aspectRatio) } : undefined"
        />
        <UiEmptyState v-if="noRenderer">No renderer is registered for this environment.</UiEmptyState>
      </section>

      <section v-if="logBeside" class="stage-log" aria-label="Decision log">
        <h2 class="stage-title">Decision log</h2>
        <div class="stage-log-body">
          <DecisionLog :entries="decisions" :current-index="replayState.index" />
        </div>
      </section>
      <details v-else class="stage-log stage-log-below">
        <summary>Decision log</summary>
        <DecisionLog :entries="decisions" :current-index="replayState.index" />
      </details>
    </div>
  </section>
</template>

<style scoped>
.context-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin: 0 0 var(--space-4);
}

.context-line {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.context-line a:hover {
  color: var(--color-accent);
}

.context-pin {
  flex: none;
}

.replay-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 640px;
  margin: var(--space-3) 0;
}

/* Touch targets: the transport controls clear the 44px minimum (the accessibility baseline). */
.replay-controls :deep(.ui-button) {
  min-height: 44px;
}

.scrubber {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  min-height: 44px;
}

.replay-position {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.stage {
  display: grid;
  gap: var(--space-4);
}

.stage:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: var(--space-2);
  border-radius: var(--radius-md);
}

/* Beside layout: the columns stretch to a common height so the log matches the canvas to its left,
   and each column is a header + body stack so the two headers sit on the same baseline. */
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

.stage-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-md);
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

@media (max-width: 768px) {
  .stage.beside {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }

  .replay-controls {
    flex-wrap: wrap;
  }
}
</style>
