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
import { computed, nextTick, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'

import {
  getRecording,
  getRecordingLlm,
  listRecordings,
  listSeasons,
  type RecordingLlmTelemetry,
  type RecordingSummary,
  watchAgentNumbers,
} from '../api/client.js'
import DecisionLog, { type DecisionEntry } from '../components/DecisionLog.vue'
import ExperimentTabs from '../components/ExperimentTabs.vue'
import GameOverCard from '../components/GameOverCard.vue'
import GameThread from '../components/GameThread.vue'
import PlayerAttribution from '../components/PlayerAttribution.vue'
import RunMetadata from '../components/RunMetadata.vue'
import StageFrame from '../components/StageFrame.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiSlider from '../components/ui/UiSlider.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { usePinning } from '../composables/usePinning.js'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useReplayTransport } from '../composables/useReplayTransport.js'
import { useStageLayout } from '../composables/useStageLayout.js'
import { environmentMeta } from '../environmentCatalog.js'
import { anonymityState, presentsMasked } from '../lib/anonymity.js'
import { hasSubmittedAgent } from '../lib/attribution.js'
import { type ChatEntry } from '../lib/chat.js'
import { formatDate } from '../lib/format.js'
import { playbackIntervalMs } from '../lib/playback.js'
import { isAdmin, useMe, userId } from '../me.js'
import { parseRecording, UnsupportedVersionError } from '../replay/parse.js'
import { isCompletedOutcome, reasonText } from '../replay/reason.js'
import { type RunSummary, summarizeStates } from '../replay/summary.js'

const route = useRoute()
const me = useMe()
const id = String(route.params.id)
// The signed-in viewer's id for the attribution components' optional `viewer-id` prop (undefined when
// anonymous). The prop takes `string | undefined`, so the `null` sentinel maps to `undefined`.
const viewerId = computed(() => userId(me.me) ?? undefined)

const loading = ref(true)
const loadError = ref(false)
const versionMessage = ref<string | null>(null)
const header = ref<RecordingHeader | null>(null)
const meta = ref<EnvironmentMeta | null>(null)
const finalSummary = ref<RunSummary>({ score: null, ticks: null })
// The terminal frame, kept so the end-of-match leaderboard can read its final scores/overlay. The
// viewer can dismiss the leaderboard to inspect the final board underneath.
const finalState = shallowRef<StepState | null>(null)
const gameOverDismissed = ref(false)
const listingEntry = ref<RecordingSummary | null>(null)
const owned = ref(false)
const decisions = ref<DecisionEntry[]>([])
// Recording telemetry is deliberately independent from the JSONL recording. Broken retained
// telemetry must never prevent the renderer and transport from loading, and it must not be confused
// with a successful empty telemetry payload.
const llmTelemetry = ref<RecordingLlmTelemetry | null>(null)
const llmTelemetryUnavailable = ref(false)
const llmPending = computed(() => llmTelemetry.value === null && !llmTelemetryUnavailable.value)
const tickLlmCalls = computed(
  () => llmTelemetry.value?.calls.filter((call) => call.tick !== null) ?? [],
)
const setupLlmCalls = computed(
  () => llmTelemetry.value?.calls.filter((call) => call.tick === null) ?? [],
)
// The full message log, built once from the recording at load (recordings keep every message by
// design). It never mutates afterward, so a shallowRef is enough.
const chatLog = shallowRef<ChatEntry[]>([])
const seasonPlayable = ref<boolean | null>(null)
// Submission id → season-wide anonymous number, so the blind attribution line reads the same
// "Agent N" the watch picker and rating panel show for the same agent.
const anonymousNumbers = ref<Record<string, number>>({})

const hostEl = ref<HTMLElement | null>(null)

const { noRenderer, aspectRatio, mount: mountRenderer, render: renderState } = useRendererMount({
  host: hostEl,
  meta,
})
const { state: replayState, transport, init: initTransport, onKeydown } = useReplayTransport()
// The leaderboard appears once the playhead reaches the final frame of a run that finished play
// (mirrors the live page), and stays dismissable. The producing session's termination reason comes
// with the listing; a run that was stopped or crashed shows no final standings, and an unclaimed
// recording (no listing reason) stays conservative and shows none.
const showGameOver = computed(
  () =>
    replayState.value.total > 0 &&
    replayState.value.index >= replayState.value.total - 1 &&
    isCompletedOutcome(listingEntry.value?.termination_reason ?? null),
)
const { pinned, busy: pinBusy, error: pinError, toggle: togglePin } = usePinning(id)
// Fail closed: anyone not confirmed an operator (including an unresolved identity) sees the blind
// attribution while the season is playable — but only when the recording actually carries a
// submitted agent to protect; blind ownership masking has nothing to hide in an all-human or
// all-Naive recording (mirrors ReplaysPage's isBlindReplay gate).
const attributionState = computed(() =>
  anonymityState({
    identityResolved: !me.loading,
    operator: isAdmin(me.me),
    seasonPlayable: seasonPlayable.value,
    hasSubmittedAgent: header.value === null ? null : hasSubmittedAgent(header.value.players),
  }),
)
const blindAttribution = computed(() => presentsMasked(attributionState.value))

// The panel mounts only for a recording that actually carries messages (a messaging session); it is
// read-only, with no session row to consult. It shows the entries whose tick is at or before the
// transport position — the same pattern the decision log uses with :current-index. Targeted messages a
// live spectator never saw are shown here on purpose; that is the recording contract.
const hasChat = computed(() => chatLog.value.length > 0)
const visibleChat = computed<ChatEntry[]>(() => {
  const tick = replayState.value.tick
  return tick === null ? [] : chatLog.value.filter((entry) => entry.tick <= tick)
})

// The decision log sits beside a portrait canvas and below a landscape one until the viewport is wide
// enough to hold both (the same rule as live; see useStageLayout).
const { logBeside } = useStageLayout(aspectRatio)

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
  { label: 'Ticks', value: finalSummary.value.ticks },
  {
    label: 'Owner',
    value: blindAttribution.value
      ? null
      : (listingEntry.value?.user_name ?? listingEntry.value?.user_id),
    // The stable id rides as a tooltip whenever the owner is actually shown; the item itself vanishes
    // (via the null value above) rather than showing a masked placeholder when blind.
    title: blindAttribution.value ? undefined : (listingEntry.value?.user_id ?? undefined),
  },
  { label: 'Created', value: formatDate(listingEntry.value?.created_at) },
])

// While the game-over card is up it owns the keyboard, so the transport stands down: a stray Space
// shouldn't restart playback behind the card. Escape from the stage still dismisses it (the card's own
// handler covers Escape when focus is within the card).
function onStageKeydown(event: KeyboardEvent): void {
  if (showGameOver.value && !gameOverDismissed.value) {
    if (event.key === 'Escape') {
      gameOverDismissed.value = true
    }
    return
  }
  onKeydown(event)
}

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
  const telemetryPromise = getRecordingLlm(id).catch(() => ({
    ok: false as const,
    reason: 'telemetry_unavailable' as const,
  }))
  void telemetryPromise.then((result) => {
    if (result.ok) {
      llmTelemetry.value = result.telemetry
    } else {
      llmTelemetryUnavailable.value = true
    }
  })
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
  finalState.value = parsed.states.at(-1) ?? null
  decisions.value = parsed.states.map(toDecision)
  // Build the whole message log up front, tagging each message with its state's tick (the wire message
  // carries no tick of its own). The transport position then filters what shows.
  chatLog.value = parsed.states.flatMap((state) =>
    (state.messages ?? []).map((message) => ({ tick: state.tick, ...message })),
  )
  loading.value = false
  await nextTick()

  meta.value = await environmentMeta(parsed.header.environment).catch(() => null)
  if (meta.value === null) {
    noRenderer.value = true
  } else {
    mountRenderer(parsed.header)
  }

  initTransport(parsed.states, {
    // A realtime env paces by its step interval; a turn-based one (Hearts) declares a viewing cadence
    // so the replay plays at a watchable speed rather than the transport's bare default.
    paceIntervalMs: playbackIntervalMs(meta.value),
    onFrame: (state, renderOptions) => renderState(state, renderOptions),
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
    listRecordings({ env: parsed.header.environment }).catch(() => null),
    listSeasons(parsed.header.environment).catch(() => null),
  ])
  const entry = listing?.find((r) => r.id === id)
  seasonPlayable.value =
    entry === undefined || seasons === null
      ? null
      : entry.season_id === null
        ? false
        : seasons.some((season) => season.id === entry.season_id && season.play_status === 'open')
  // Only a blind viewer needs the anonymous numbering; an operator (or a closed season) sees real
  // owner labels and skips the lookup.
  listingEntry.value = entry ?? null
  if (attributionState.value === 'masked') {
    anonymousNumbers.value = await watchAgentNumbers(parsed.header.environment).catch(() => ({}))
  }
  if (entry !== undefined && viewerId.value !== undefined && entry.user_id === viewerId.value) {
    owned.value = true
    pinned.value = entry.pinned
  }
})
</script>

<template>
  <UiEmptyState v-if="loading">Loading replay…</UiEmptyState>
  <UiEmptyState v-else-if="loadError" tone="danger"
    >Could not load this replay.</UiEmptyState
  >
  <UiEmptyState v-else-if="versionMessage !== null">
    This replay needs a newer viewer. {{ versionMessage }}
  </UiEmptyState>
  <section v-else class="replay">
    <ExperimentTabs
      v-if="header !== null"
      class="replay-tabs"
      :env-id="header.environment"
    />

    <header class="replay-bar">
      <div class="replay-status">
        <UiStatusBadge tone="neutral" :label="statusLabel" />
        <RunMetadata
          class="status-facts"
          :items="metadataItems"
          :llm-telemetry="llmTelemetry ?? undefined"
        />
      </div>
    </header>

    <PlayerAttribution
      :players="header?.players"
      :blind="blindAttribution"
      :viewer-id="viewerId"
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
        <UiSlider
          v-model="scrubIndex"
          :max="Math.max(0, replayState.total - 1)"
          label="Replay position"
        />
      </div>
      <span class="replay-position">
        tick {{ replayState.tick ?? 0 }} ·
        {{ replayState.index + 1 }}/{{ replayState.total }}
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

    <UiEmptyState
      v-if="owned && pinError !== null"
      tone="danger"
      >{{ pinError }}</UiEmptyState
    >
    <UiEmptyState v-if="llmTelemetryUnavailable" tone="danger">
      LLM cost data unavailable.
    </UiEmptyState>

    <StageFrame
      :aspect-ratio="aspectRatio"
      :log-beside="logBeside"
      :loading="stageLoading"
      canvas-label="Replay"
      stage-label="Replay stage"
      :beside-log-label="hasChat ? undefined : 'Decision log'"
      @renderer-host="hostEl = $event"
      @keydown="onStageKeydown"
    >
      <template #overlay>
        <!-- The shared cross-environment game-over leaderboard, shown at the final frame. -->
        <GameOverCard
          v-if="finalState !== null && showGameOver && !gameOverDismissed"
          :state="finalState"
          :header="header"
          :blind="blindAttribution"
          :viewer-id="viewerId"
          :anonymous-numbers="anonymousNumbers"
          @dismiss="gameOverDismissed = true"
        />
      </template>
      <template #renderer-status>
        <UiEmptyState v-if="noRenderer"
          >No renderer is registered for this environment.</UiEmptyState
        >
      </template>
      <!-- A replay scrubs the whole game, so the decision log and chat merge into one thread: every
           tick's decision (the whole game, ahead-of-scrubber ticks dimmed) with its messages woven in
           as the scrubber reveals them. Without messaging there is nothing to merge, so the decision
           log keeps its table. -->
      <template #beside-log>
        <GameThread
          v-if="hasChat"
          :decisions="decisions"
          :chat="visibleChat"
          :current-index="replayState.index"
          :players="header?.players"
          :blind="blindAttribution"
          :viewer-id="viewerId"
          :anonymous-numbers="anonymousNumbers"
          :llm-calls="tickLlmCalls"
          :setup-llm-calls="setupLlmCalls"
          :llm-unavailable="llmTelemetryUnavailable"
          :llm-pending="llmPending"
        />
        <DecisionLog
          v-else
          :entries="decisions"
          :current-index="replayState.index"
          :llm-calls="tickLlmCalls"
          :setup-llm-calls="setupLlmCalls"
          :llm-unavailable="llmTelemetryUnavailable"
          :llm-pending="llmPending"
        />
      </template>
      <template #below-log>
        <details
          v-if="!logBeside && hasChat"
          class="stage-log-below stage-thread-below"
        >
          <summary>Game thread</summary>
          <GameThread
            :decisions="decisions"
            :chat="visibleChat"
            :current-index="replayState.index"
            :players="header?.players"
            :blind="blindAttribution"
            :viewer-id="viewerId"
            :anonymous-numbers="anonymousNumbers"
            :llm-calls="tickLlmCalls"
            :setup-llm-calls="setupLlmCalls"
            :llm-unavailable="llmTelemetryUnavailable"
            :llm-pending="llmPending"
          />
        </details>
        <details v-else-if="!logBeside" class="stage-log-below">
          <summary>Decision log</summary>
          <DecisionLog
            :entries="decisions"
            :current-index="replayState.index"
            :llm-calls="tickLlmCalls"
            :setup-llm-calls="setupLlmCalls"
            :llm-unavailable="llmTelemetryUnavailable"
            :llm-pending="llmPending"
          />
        </details>
      </template>
    </StageFrame>
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

@media (max-width: 768px) {
  .replay-controls {
    flex-wrap: wrap;
  }
}
</style>
