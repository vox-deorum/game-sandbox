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
import { useRoute } from 'vue-router'

import {
  getEnvironments,
  getRecording,
  listRecordings,
  listSeasons,
  type RecordingSummary,
  watchAgentNumbers,
} from '../api/client.js'
import DecisionLog, { type DecisionEntry } from '../components/DecisionLog.vue'
import ExperimentTabs from '../components/ExperimentTabs.vue'
import PlayerAttribution from '../components/PlayerAttribution.vue'
import RunMetadata from '../components/RunMetadata.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiSlider from '../components/ui/UiSlider.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { usePinning } from '../composables/usePinning.js'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useReplayTransport } from '../composables/useReplayTransport.js'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'
import { parseRecording, UnsupportedVersionError } from '../replay/parse.js'
import { reasonText } from '../replay/reason.js'
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
const seasonPlayable = ref(false)
// Submission id → season-wide anonymous number, so the blind attribution line reads the same
// "Submitted agent N" the watch picker and rating panel show for the same agent.
const anonymousNumbers = ref<Record<string, number>>({})

const hostEl = ref<HTMLElement | null>(null)

const { noRenderer, aspectRatio, mount: mountRenderer, render: renderState } = useRendererMount({
  host: hostEl,
  meta,
})
const { state: replayState, transport, init: initTransport, onKeydown } = useReplayTransport()
const { pinned, busy: pinBusy, error: pinError, toggle: togglePin } = usePinning(id)
// Fail closed: anyone not confirmed an operator (including an unresolved identity) sees the blind
// attribution while the season is playable.
const blindAttribution = computed(
  () => seasonPlayable.value && me.me?.is_operator !== true,
)

// The decision log sits beside a portrait canvas and below a landscape one (the same rule as live).
const logBeside = computed(() => aspectRatio.value !== null && aspectRatio.value < 1)

// The recording is loaded but the renderer hasn't reported its shape yet, so the stage shows a loading
// indicator rather than the decision log. (Stays false when no renderer is registered — its own state.)
const stageLoading = computed(() => aspectRatio.value === null && !noRenderer.value)

// The status badge mirrors the ended-session card: it names how the run ended once the listing supplies
// the producing session's termination reason, falling back to a plain "Replay" until then (or when no
// ended session claims the recording).
const statusLabel = computed(() =>
  listingEntry.value?.termination_reason != null
    ? reasonText(listingEntry.value.termination_reason)
    : 'Replay',
)

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
  { label: 'Owner', value: blindAttribution.value ? null : listingEntry.value?.user_id },
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
  const [listing, seasons] = await Promise.all([
    listRecordings({ env: parsed.header.environment }).catch(() => []),
    listSeasons(parsed.header.environment).catch(() => []),
  ])
  const entry = listing.find((r) => r.id === id)
  listingEntry.value = entry ?? null
  seasonPlayable.value =
    entry?.season_id != null &&
    seasons.some((season) => season.id === entry.season_id && season.play_status === 'open')
  // Only a blind viewer needs the anonymous numbering; an operator (or a closed season) sees real
  // owner labels and skips the lookup.
  if (blindAttribution.value) {
    anonymousNumbers.value = await watchAgentNumbers(parsed.header.environment).catch(() => ({}))
  }
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
    <ExperimentTabs v-if="header !== null" class="replay-tabs" :env-id="header.environment" />

    <header class="replay-bar">
      <div class="replay-status">
        <UiStatusBadge tone="neutral" :label="statusLabel" />
        <RunMetadata class="status-facts" :items="metadataItems" />
      </div>
    </header>

    <PlayerAttribution
      :players="header?.players"
      :blind="blindAttribution"
      :viewer-id="me.me?.user_id"
      :anonymous-numbers="anonymousNumbers"
    />

    <div v-if="transport !== null" class="replay-controls">
      <UiButton
        variant="secondary"
        size="tight"
        aria-label="Step back"
        :disabled="replayState.index === 0"
        @click="transport?.stepBack()"
      >
        <span aria-hidden="true">←</span>
      </UiButton>
      <UiButton size="tight" @click="transport?.toggle()">
        {{ replayState.playing ? 'Pause' : 'Play' }}
      </UiButton>
      <UiButton
        variant="secondary"
        size="tight"
        aria-label="Step forward"
        :disabled="replayState.index >= replayState.total - 1"
        @click="transport?.stepForward()"
      >
        <span aria-hidden="true">→</span>
      </UiButton>
      <div class="scrubber">
        <UiSlider v-model="scrubIndex" :max="Math.max(0, replayState.total - 1)" label="Replay position" />
      </div>
      <span class="replay-position">
        tick {{ replayState.tick ?? 0 }} · {{ replayState.index + 1 }}/{{ replayState.total }}
      </span>
      <UiButton
        v-if="owned"
        variant="secondary"
        size="tight"
        :loading="pinBusy"
        @click="togglePin"
      >
        {{ pinned ? 'Pinned ✓' : 'Pin recording' }}
      </UiButton>
    </div>

    <UiEmptyState v-if="owned && pinError !== null" tone="danger">{{ pinError }}</UiEmptyState>

    <div
      class="stage"
      :class="logBeside ? 'beside' : 'below'"
      tabindex="0"
      role="group"
      aria-label="Replay stage"
      @keydown="onKeydown"
    >
      <section class="stage-canvas" aria-label="Replay">
        <div
          class="renderer-host"
          ref="hostEl"
          :style="aspectRatio !== null ? { aspectRatio: String(aspectRatio) } : undefined"
        />
        <UiEmptyState v-if="noRenderer">No renderer is registered for this environment.</UiEmptyState>
      </section>

      <div v-if="stageLoading" class="stage-log stage-loading" role="status">
        <span class="overlay-spinner" aria-hidden="true" />
        <span>Loading…</span>
      </div>
      <section v-else-if="logBeside" class="stage-log" aria-label="Decision log">
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
/* The shared tab strip carries its own full-width border and an inner max-width/padding that the shell
   normally aligns to the page edges. Inside the padded page content we bleed it back out by the page
   padding so its border spans the content width and its inner labels line up with the page below. */
.replay-tabs {
  margin: calc(var(--space-5) * -1) calc(var(--space-5) * -1) var(--space-4);
}

.replay-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
  flex-wrap: wrap;
}

.replay-status {
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

/* While the renderer mounts, a centered spinner stands in for the decision log it has no rows for. */
.stage-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6) 0;
  color: var(--color-text-muted);
  font-size: var(--text-md);
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
