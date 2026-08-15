<!--
  The live session page: it fetches the session row, connects the socket, and mounts the environment's
  renderer over the live stream. The renderer owns the game frame; this page owns the session chrome
  that works for every environment — the status strip, the pause/resume toggle, the stop button, the
  decision log, and the end-of-session card with the replay link and pin.

  The chrome is composed from small composables: useSessionSocket owns the socket and the state derived
  from its frames, useRendererMount owns the canvas, usePinning owns the pin toggle. Capabilities derive
  from identity and mode: the owner of a human session controls the human players and gets a live
  sendAction; everyone else is a spectator (same renderer, no controls). Pause is either a session
  pause the container confirms by echo or a playback pause local to this browser, chosen by the
  environment's `human_pause`; a watch run always pauses playback.

  An already-ended session is a historical view, not a live transport. It hydrates the final facts and
  the decision log from the stored recording and never opens a socket.
-->
<script setup lang="ts">
import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  getRecording,
  getSession,
  listSeasons,
  listRecordings,
  type SessionRow,
  watchAgentNumbers,
} from '../api/client.js'
import ChatPanel from '../components/ChatPanel.vue'
import DecisionLog from '../components/DecisionLog.vue'
import ExperimentTabs from '../components/ExperimentTabs.vue'
import GameOverCard from '../components/GameOverCard.vue'
import PlayerAttribution from '../components/PlayerAttribution.vue'
import RunMetadata from '../components/RunMetadata.vue'
import SessionRatings from '../components/SessionRatings.vue'
import StageFrame from '../components/StageFrame.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { usePinning } from '../composables/usePinning.js'
import { useLiveFramePresentation } from '../composables/useLiveFramePresentation.js'
import { useLiveChat } from '../composables/useLiveChat.js'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useSessionSocket } from '../composables/useSessionSocket.js'
import { useStageLayout } from '../composables/useStageLayout.js'
import { environmentMeta } from '../environmentCatalog.js'
import { anonymityState, presentsMasked } from '../lib/anonymity.js'
import { hasSubmittedAgent } from '../lib/attribution.js'
import { formatDate } from '../lib/format.js'
import { liveIntervalMs, playbackIntervalMs } from '../lib/playback.js'
import { decisionEntries } from '../lib/state.js'
import { isAdmin, useMe, userId } from '../me.js'
import { parseRecording } from '../replay/parse.js'
import { summarizeStates } from '../replay/summary.js'
import { playerNamesFor } from '../renderers/registry.js'

const route = useRoute()
const me = useMe()
const id = String(route.params.id)
// The signed-in viewer's id for the attribution components' optional `viewer-id` prop (undefined when
// anonymous). The prop takes `string | undefined`, so the `null` sentinel maps to `undefined`.
const viewerId = computed(() => userId(me.me) ?? undefined)

const row = ref<SessionRow | null>(null)
const meta = ref<EnvironmentMeta | null>(null)
const loadError = ref(false)
const hostEl = ref<HTMLElement | null>(null)
const seasonPlayable = ref<boolean | null>(null)
// Submission id → season-wide anonymous number, so the blind attribution line reads the same
// "Agent N" the watch picker and post-session rating panel show for the same agent.
const anonymousNumbers = ref<Record<string, number>>({})
// The recording header carries per-player attribution (`players`); retained to show who played.
const header = ref<RecordingHeader | null>(null)
// The environment's own display names for this recording's players (e.g. Days at Three Branches'
// character names), for the chat surfaces to show in place of compact player ids. Undefined until the
// renderer's metadata and the header are both in, or when the renderer supplies none.
const chatPlayerNames = computed(() =>
  meta.value === null || header.value === null
    ? undefined
    : playerNamesFor(meta.value.renderer, header.value),
)
// The last frame drawn, kept so the end-of-match leaderboard can read the terminal scores/overlay.
// shallowRef: a StepState is a large value the card reads whole, not deep-reactive data.
const lastState = shallowRef<StepState | null>(null)
// The viewer can dismiss the game-over leaderboard to inspect the final board underneath.
const gameOverDismissed = ref(false)

const isOwner = computed(
  () => viewerId.value !== undefined && row.value?.user_id === viewerId.value,
)
// The recording header identifies every player this viewer controls as a human. Use that attribution
// instead of every human-capable player. Before the
// header arrives, return [] so a human controlling player_2 never briefly gets player_0's controls.
//
// This is independent of run status on purpose: it is the viewer's *identity* in the match, which the
// chat panel needs to keep badging their own lines "from you"/"to you" even on an ended session's
// read-only history. Control (below) is what drops at end, not identity.
const viewerPlayers = computed<string[]>(() => {
  if (!(isOwner.value && row.value?.mode === 'human')) {
    return []
  }
  const players = header.value?.players
  if (players === undefined) {
    return [] // Header not yet arrived: fail closed (see above).
  }
  return Object.keys(players).filter((playerId) => players[playerId]?.kind === 'human')
})
// The players this viewer actively drives, but only while the session is live. An ended session is
// read-only history, so control affordances (renderer input and sending) drop even though the player
// identity above persists.
const controlledPlayers = computed<string[]>(() =>
  status.value === 'ended' ? [] : viewerPlayers.value,
)
const recordingId = computed(() => row.value?.recording_id ?? null)
// Fail closed: anyone not confirmed an operator (including an unresolved identity) is treated as a
// possibly-blind viewer while the season is playable. This coarser signal (not yet knowing whether the
// header even carries a submitted agent) is what gates the anonymous-numbering prefetch below, because
// a live session's header arrives asynchronously — often after that prefetch runs — so it cannot wait
// on hasSubmittedAgent the way the render-facing gate does.
const attributionState = computed(() =>
  anonymityState({
    identityResolved: !me.loading,
    operator: isAdmin(me.me),
    seasonPlayable: seasonPlayable.value,
    hasSubmittedAgent: header.value === null ? null : hasSubmittedAgent(header.value.players),
  }),
)
const blindAttribution = computed(() => presentsMasked(attributionState.value))
let anonymousNumbersRequested = false
watch(attributionState, (state) => {
  if (state !== 'masked' || anonymousNumbersRequested || row.value === null) return
  anonymousNumbersRequested = true
  void watchAgentNumbers(row.value.env_id).then(
    (numbers) => { anonymousNumbers.value = numbers },
    () => { anonymousNumbers.value = {} },
  )
})

// The socket owns the chrome state and hands recording frames back here to draw and log; the renderer
// (shared with replay) forwards the owner's live input. They reference each other through stable
// functions called later, so only the values read during setup fix this order: the renderer mount
// reads the socket's `paused`.
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
  setControlHeld,
  togglePause,
  stop,
  send,
} = useSessionSocket(id, {
    onHeader: (incoming) => {
      header.value = incoming
      mountRenderer(incoming)
    },
    onState: (state, options) => {
      // Returned so paced playout waits for this frame's transition before delivering the next.
      const drawn = renderState(state, options)
      lastState.value = state
      // Accumulate messages before the decision-log gate: an actionless opening frame still carries
      // any human-queued messages. onState is called at render (drain) time, so a message appears
      // exactly when its state line renders, not ahead of it.
      appendMessages(state)
      // Opening frames and reward-only deltas carry no actions, so the shared adapter omits them.
      appendDecisions(state)
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
const { pinned, busy: pinBusy, error: pinError, toggle: togglePin } = usePinning(recordingId)

// The chat panel mounts when the session's effective messaging block enables it, resolved once by the
// orchestrator from the metadata and the season override, persisted on the row so live and reopened
// ended payloads agree. A season-silenced session shows no dead panel.
const messagingEnabled = computed(() => (row.value?.messaging_enabled ?? 0) !== 0)
const liveChatEnabled = computed(() => row.value?.mode === 'human' && status.value === 'running')
const { chatProps, sendInput, sendChat } = useLiveChat({
  state: latestState,
  controlledPlayers,
  enabled: liveChatEnabled,
  connection,
  send,
})

// The decision log sits beside a portrait canvas (a column is left free) and below a landscape one
// until the viewport is wide enough to hold both (see useStageLayout).
const { logBeside } = useStageLayout(aspectRatio)

// The renderer hasn't reported its shape yet: the session row, socket, and first header are still in
// flight, so the stage shows a loading indicator rather than the decision log it has no rows for.
// (Stays false when no renderer is registered — that's its own empty state.)
const stageLoading = computed(() => aspectRatio.value === null && !noRenderer.value)

// The run's own facts, shown inline in the status row beside the badge. The tabs name the environment,
// the status badge names the end reason, and the pin button shows pin state — so the strip carries only
// score, ticks, and start time. Score and ticks resolve only once a session ends, so RunMetadata's
// drop-empties rule keeps a live session's row to just the start time.
const statusFacts = computed(() => [
  { label: 'Score', value: finalResult.value?.score },
  { label: 'Ticks', value: finalResult.value?.ticks },
  { label: 'Started', value: formatDate(row.value?.created_at) },
])
const completePlayerScores = computed(
  () => finalResult.value?.scores ?? accumulatedScores.value,
)

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
  const [environment, seasons] = await Promise.all([
    environmentMeta(fetched.env_id).catch(() => null),
    listSeasons(fetched.env_id).catch(() => null),
  ])
  // The renderer reads the move-clock budget from `meta.human_timeout_ms`, which carries only the
  // environment default. Overlay the session's own resolved value (its override or that default) so a
  // session started with a custom human timeout shows the right clock. A copy, so the shared env-meta
  // object the registry hands out is not mutated. Only a session that carries one overrides; otherwise
  // the env default stands.
  meta.value =
    environment !== null && fetched.human_timeout_ms !== null
      ? { ...environment, human_timeout_ms: fetched.human_timeout_ms }
      : environment
  seasonPlayable.value =
    fetched.season_id === null
      ? false
      : seasons === null
        ? null
        : seasons.some((season) => season.id === fetched.season_id && season.play_status === 'open')
  if (meta.value === null) {
    noRenderer.value = true
  }

  // Identity must be resolved before the renderer mounts (attach replays the header immediately), or
  // the owner would be misjudged a spectator. The shared /api/me fetch is usually settled by now; this
  // awaits it rather than polling, closing the race.
  await me.whenSettled()

  // Only a possibly-blind viewer needs the anonymous numbering, and only then does it apply; an
  // operator (or a closed season) sees real owner labels and skips the lookup. Gated on the coarser
  // signal, not the render-facing blindAttribution: a live session's header (which hasSubmittedAgent
  // reads) has not arrived yet at this point, so waiting on it here would skip the prefetch entirely.
  if (fetched.status === 'ended') {
    // Historical sessions have no live socket to attach to; the recording is the source of truth.
    await hydrateRecording(fetched)
    connection.value = 'closed'
    return
  }
  // A watch run (scripted) plays paced so a container that streams faster than real time still
  // animates at the environment's cadence and reveals game over only once the frames have played
  // out. A human session renders its owner's own move on arrival for immediate feedback, but a
  // turn-based env's `live_interval_ms` throttles the other players' burst so it animates card-by-card.
  connect({
    pace: fetched.mode === 'scripted',
    // A realtime env paces by its step interval; a turn-based one (Hearts) declares a viewing cadence
    // so a scripted watch plays out at a watchable speed rather than the buffer's bare default.
    paceMs: playbackIntervalMs(meta.value),
    // Live human play throttles opponents' moves at the env's live cadence; null (realtime, or an env
    // that declares none) keeps the unbuffered on-arrival behaviour.
    liveMs: fetched.mode === 'human' ? liveIntervalMs(meta.value) : null,
    // Whether this env's human sessions pause the container itself or only this viewer's playout. A
    // watch run ignores it and always pauses playout, since its container is usually already gone.
    sessionPause: meta.value?.human_pause === 'session',
  })
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
    decisions.value = parsed.states.flatMap(decisionEntries)
    // A directly opened ended session never streams through onState, so build its message log from the
    // same parsed states — the full exchange, read-only, with no live socket.
    parsed.states.forEach(appendMessages)
    mountRenderer(parsed.header)
    const finalState = parsed.states.at(-1)
    if (finalState !== undefined) {
      renderState(finalState)
      // Feed the same terminal frame to the end-of-match leaderboard. A directly-opened ended session
      // never streams through onState, so this is the only place its lastState is set.
      lastState.value = finalState
    }
    if (finalResult.value === null) {
      finalResult.value = summarizeStates(parsed.states)
    }
  } catch {
    if (finalResult.value === null) {
      finalResult.value = { score: null, ticks: null, scores: {} }
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
      :viewer-id="viewerId"
      :anonymous-numbers="anonymousNumbers"
    />

    <!-- End-of-session feedback appears only after termination, immediately above the game stage.
         The ratings read is protected, so an anonymous spectator sees a sign-in prompt instead of a
         redirect: they may watch a public session through its end without signing in. -->
    <SessionRatings v-if="status === 'ended' && me.me?.user != null" :session-id="id" />
    <UiEmptyState v-else-if="status === 'ended' && !me.loading">
      <RouterLink class="sign-in-link" to="/login">Sign in</RouterLink> to rate the agents in this
      session.
    </UiEmptyState>

    <StageFrame
      :aspect-ratio="aspectRatio"
      :log-beside="logBeside"
      :loading="stageLoading"
      loading-label="Loading session…"
      canvas-label="Environment"
      :beside-log-label="messagingEnabled ? undefined : 'Decision log'"
      @renderer-host="hostEl = $event"
    >
      <template #overlay>
          <div v-if="paused && status !== 'ended'" class="overlay-banner">Paused</div>
          <div
            v-else-if="buffering && status !== 'ended'"
            class="overlay-banner overlay-banner--waiting"
            role="status"
          >
            <span class="overlay-spinner" aria-hidden="true" />
            <span>Waiting…</span>
          </div>
          <!-- The shared cross-environment game-over leaderboard, over the final frame, once a run
               finishes play. Skipped for a run that was stopped, idled out, or crashed, whose partial
               board no final standings should claim. -->
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
            :blind="blindAttribution"
            :viewer-id="viewerId"
            :anonymous-numbers="anonymousNumbers"
            @dismiss="gameOverDismissed = true"
          />
      </template>
      <template #renderer-status>
        <UiEmptyState v-if="noRenderer">No renderer is registered for this environment yet.</UiEmptyState>
      </template>
      <!-- Beside layout: when messaging is on the chat takes the whole column and the decision log
           drops below the stage as the same collapsible disclosure the narrow layout uses; without
           messaging the decision log keeps the column. -->
      <template #beside-log>
            <ChatPanel
              v-if="messagingEnabled"
              :entries="chatLog"
              :players="header?.players"
              :blind="blindAttribution"
              :viewer-id="viewerId"
              :anonymous-numbers="anonymousNumbers"
              :viewer-players="viewerPlayers"
              :message-cap="row?.message_cap ?? null"
              :player-names="chatPlayerNames"
              v-bind="chatProps"
              @send="sendChat"
            />
            <DecisionLog v-else :entries="decisions" />
      </template>
      <template #below-log>
        <details v-if="logBeside && messagingEnabled" class="stage-log-below stage-decision-below">
          <summary>Decision log</summary>
          <DecisionLog :entries="decisions" />
        </details>
        <details v-if="!logBeside" class="stage-log-below">
          <summary>Decision log</summary>
          <DecisionLog :entries="decisions" />
        </details>
        <details v-if="!logBeside && messagingEnabled" class="stage-log-below stage-chat-below">
          <summary>Chat</summary>
          <ChatPanel
            :entries="chatLog"
            :players="header?.players"
            :blind="blindAttribution"
            :viewer-id="viewerId"
            :anonymous-numbers="anonymousNumbers"
            :viewer-players="viewerPlayers"
            :message-cap="row?.message_cap ?? null"
            :player-names="chatPlayerNames"
            v-bind="chatProps"
            @send="sendChat"
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

.sign-in-link {
  color: var(--color-accent);
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
  animation: overlay-spin var(--motion-spinner) linear infinite;
}

@keyframes overlay-spin {
  to {
    transform: rotate(360deg);
  }
}

</style>
