<!-- Browser local play uses the production renderer and live socket contracts, but no router or account state. -->
<script setup lang="ts">
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'

import ChatPanel from '../components/ChatPanel.vue'
import DecisionLog from '../components/DecisionLog.vue'
import GameOverCard from '../components/GameOverCard.vue'
import StageFrame from '../components/StageFrame.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useSessionSocket } from '../composables/useSessionSocket.js'
import { useStageLayout } from '../composables/useStageLayout.js'
import { useLiveFramePresentation } from '../composables/useLiveFramePresentation.js'
import { useLiveChat } from '../composables/useLiveChat.js'
import { loadEnvironmentCatalog } from '../environmentCatalog.js'
import { liveIntervalMs, playbackIntervalMs } from '../lib/playback.js'

const meta = ref<EnvironmentMeta | null>(null)
const loadError = ref(false)
const hostEl = ref<HTMLElement | null>(null)
const header = ref<RecordingHeader | null>(null)
const lastState = shallowRef<StepState | null>(null)
const gameOverDismissed = ref(false)
// The first resume is the start gate; the relay replays its pause echo until then. Afterwards the
// Pause control is an ordinary session or playback pause, depending on the environment.
const started = ref(false)
const startRequested = ref(false)

const controlledPlayers = computed(() =>
  Object.entries(header.value?.players ?? {})
    .filter(([, player]) => player.kind === 'human')
    .map(([playerId]) => playerId),
)

// The socket comes first because the renderer mount reads its `paused`; everything pointing the other
// way is a stable function called later.
const {
  connection,
  status,
  paused,
  buffering,
  endReason,
  finalResult,
  accumulatedScores,
  latestState,
  connect,
  send,
  setControlHeld,
  togglePause,
  stop,
} = useSessionSocket('local', {
  onHeader: (incoming) => {
    header.value = incoming
    mountRenderer(incoming)
  },
  onState: (state, options) => {
    // Returned so paced playout waits for this frame's transition before delivering the next.
    const drawn = renderState(state, options)
    lastState.value = state
    appendMessages(state)
    const entries = appendDecisions(state)
    if (entries.length > 0) {
      // The relay replays its latest acted state before the retained pause echo. A refreshed tab is
      // therefore resuming an existing session, not opening the initial start gate again.
      started.value = true
    }
    return drawn
  },
})
const { noRenderer, aspectRatio, mount: mountRenderer, render: renderState } = useRendererMount({
  host: hostEl,
  meta,
  controlledPlayers,
  // Deferred so the renderer and the chat composable can be wired in either order.
  sendAction: (playerId, action) => sendInput(playerId, action),
  onControlHeld: setControlHeld,
  paused,
})
const {
  appendDecisions,
  appendMessages,
  chatLog,
  completedOutcome,
  decisions,
  statusLabel,
  statusTone,
} = useLiveFramePresentation({
  status,
  paused,
  endReason,
})
const completePlayerScores = computed(
  () => finalResult.value?.scores ?? accumulatedScores.value,
)

// Leaving the paused state is what retires the start gate, whichever pause cleared it. This only
// switches the first-control label; the socket owns the pause state itself.
watch(paused, (value) => {
  if (!value && status.value === 'running') {
    started.value = true
    startRequested.value = false
  }
})

const { logBeside } = useStageLayout(aspectRatio)
const stageLoading = computed(() => meta.value === null || (aspectRatio.value === null && !noRenderer.value))
const messagingEnabled = computed(() => meta.value?.messaging === true)
const liveChatEnabled = computed(() => status.value === 'running')
const { chatProps, sendInput, sendChat } = useLiveChat({
  state: latestState,
  controlledPlayers,
  enabled: liveChatEnabled,
  connection,
  send,
})
const showStartGate = computed(() => paused.value && !started.value)
const controlsReady = computed(() => header.value !== null && status.value === 'running')

function start(): void {
  startRequested.value = true
  send({ kind: 'resume' })
}

onMounted(async () => {
  try {
    const catalog = await loadEnvironmentCatalog()
    const environment = catalog[0]
    if (environment === undefined) {
      loadError.value = true
      return
    }
    meta.value = environment
    connect({
      paceWhenSpectating: true,
      // A realtime env paces by its step interval and a turn-based one by its viewing cadence, the
      // same resolution the session page uses; the raw view interval alone would leave a realtime
      // watch draining slower than the runner produces.
      paceMs: playbackIntervalMs(environment),
      liveMs: liveIntervalMs(environment),
      sessionPause: environment.human_pause === 'session',
    })
  } catch {
    loadError.value = true
  }
})
</script>

<template>
  <main class="local-play">
    <header class="local-play-bar">
      <div>
        <p class="eyebrow">Local play</p>
        <h1>{{ meta?.display_name ?? 'Game Sandbox' }}</h1>
      </div>
      <div class="local-play-status">
        <UiStatusBadge :tone="statusTone" :label="statusLabel" />
        <UiStatusBadge
          v-if="connection === 'reconnecting' && status !== 'ended'"
          tone="warning"
          label="Reconnecting…"
        />
      </div>
      <div v-if="controlsReady && status !== 'ended'" class="local-play-controls">
        <UiButton v-if="showStartGate" :loading="startRequested" @click="start">Start</UiButton>
        <UiButton v-else variant="secondary" @click="togglePause">
          {{ paused ? 'Resume' : 'Pause' }}
        </UiButton>
        <UiButton variant="danger" @click="stop">Stop</UiButton>
      </div>
    </header>

    <UiEmptyState v-if="loadError" tone="danger">
      Local play could not load its environment.
    </UiEmptyState>

    <StageFrame
      v-else
      :aspect-ratio="aspectRatio"
      :log-beside="logBeside"
      :loading="stageLoading"
      loading-label="Loading local play…"
      canvas-label="Environment"
      :beside-log-label="messagingEnabled ? 'Chat log' : 'Decision log'"
      @renderer-host="hostEl = $event"
    >
      <template #overlay>
        <div v-if="showStartGate" class="overlay-banner">Select Start when you are ready.</div>
        <div v-else-if="paused && status !== 'ended'" class="overlay-banner">Paused</div>
        <div v-else-if="buffering && status !== 'ended'" class="overlay-banner" role="status">
          Waiting…
        </div>
        <GameOverCard
          v-if="
            status === 'ended' &&
            lastState !== null &&
            !gameOverDismissed &&
            completedOutcome
          "
          :state="lastState"
          :header="header"
          :player-scores="completePlayerScores"
          @dismiss="gameOverDismissed = true"
        />
      </template>
      <template #renderer-status>
        <UiEmptyState v-if="noRenderer">No renderer is registered for this environment yet.</UiEmptyState>
      </template>
      <template #beside-log>
        <ChatPanel
          v-if="messagingEnabled"
          :entries="chatLog"
          :players="header?.players"
          :viewer-players="controlledPlayers"
          :message-cap="meta?.message_cap ?? null"
          v-bind="chatProps"
          @send="sendChat"
        />
        <DecisionLog v-else :entries="decisions" />
      </template>
      <template #below-log>
        <details v-if="!logBeside" class="stage-log-below">
          <summary>Decision log</summary>
          <DecisionLog :entries="decisions" />
        </details>
        <details v-if="logBeside && messagingEnabled" class="stage-log-below stage-decision-below">
          <summary>Decision log</summary>
          <DecisionLog :entries="decisions" />
        </details>
        <details v-if="!logBeside && messagingEnabled" class="stage-log-below stage-chat-below">
          <summary>Chat</summary>
          <ChatPanel
            :entries="chatLog"
            :players="header?.players"
            :viewer-players="controlledPlayers"
            :message-cap="meta?.message_cap ?? null"
            v-bind="chatProps"
            @send="sendChat"
          />
        </details>
      </template>
    </StageFrame>
  </main>
</template>

<style scoped>
.local-play {
  width: min(100% - var(--space-6), 60rem);
  margin: 0 auto;
  padding: var(--space-5) 0;
}

.local-play-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}

.eyebrow {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

h1 {
  margin: var(--space-1) 0 0;
  font-family: var(--font-heading);
  font-size: var(--text-2xl);
}

.local-play-status,
.local-play-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.overlay-banner {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: var(--color-scrim);
  color: var(--color-text);
  font-size: var(--text-md);
  text-align: center;
}

@media (max-width: 768px) {
  .local-play-bar {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
