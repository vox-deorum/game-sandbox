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
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'

import {
  getEnvironments,
  getRecording,
  getSession,
  listSeasons,
  listRecordings,
  type SessionRow,
  watchAgentNumbers,
} from '../api/client.js'
import DecisionLog, { type DecisionEntry } from '../components/DecisionLog.vue'
import ExperimentTabs from '../components/ExperimentTabs.vue'
import GameOverCard from '../components/GameOverCard.vue'
import PlayerAttribution from '../components/PlayerAttribution.vue'
import RunMetadata from '../components/RunMetadata.vue'
import SessionRatings from '../components/SessionRatings.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { usePinning } from '../composables/usePinning.js'
import { useRendererMount } from '../composables/useRendererMount.js'
import { useSessionSocket } from '../composables/useSessionSocket.js'
import { useStageLayout } from '../composables/useStageLayout.js'
import { formatDate } from '../lib/format.js'
import { liveIntervalMs, playbackIntervalMs } from '../lib/playback.js'
import { useMe } from '../me.js'
import { parseRecording } from '../replay/parse.js'
import { isCompletedOutcome, reasonText } from '../replay/reason.js'
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
// Submission id → season-wide anonymous number, so the blind attribution line reads the same
// "Submitted agent N" the watch picker and post-session rating panel show for the same agent.
const anonymousNumbers = ref<Record<string, number>>({})
// The recording header carries per-slot attribution (`players`); retained to show who played.
const header = ref<RecordingHeader | null>(null)
// The last frame drawn, kept so the end-of-match leaderboard can read the terminal scores/overlay.
// shallowRef: a StepState is a large value the card reads whole, not deep-reactive data.
const lastState = shallowRef<StepState | null>(null)
// The viewer can dismiss the game-over leaderboard to inspect the final board underneath.
const gameOverDismissed = ref(false)

const isOwner = computed(
  () => me.me?.user_id !== undefined && row.value?.user_id === me.me.user_id,
)
// The slots this viewer actually drives. It must be the one seat the human took, not every
// human-capable seat: the renderer reads `controlled[0]` as the single controlled seat, so passing all
// of `meta.human_slots` would pin control to seat 0 and lock a human seated elsewhere out of play. The
// recording header's `players` map records which seat the human occupies (`kind: 'human'`), so we
// narrow to that. Before the header arrives (or on an older header without attribution) we return []
// rather than the env's human-capable seats, so a human seated at player_2 never briefly gets
// player_0's control affordances; by the time the renderer mounts (on the header) the narrowed seat
// is known.
const controlledSlots = computed<string[]>(() => {
  if (!(isOwner.value && row.value?.mode === 'human' && status.value !== 'ended')) {
    return []
  }
  const players = header.value?.players
  if (players !== undefined) {
    const humanSlots = Object.keys(players).filter((slot) => players[slot]?.kind === 'human')
    if (humanSlots.length > 0) {
      return humanSlots
    }
  }
  // Header not yet arrived: fail closed to [] (see above).
  return []
})
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
    onState: (state, options) => {
      renderState(state, options)
      lastState.value = state
      // The live-only opening frame (a turn-based deal) carries no acting agent: render it so the
      // table shows before the first move, but keep it out of the decision log, which logs actions.
      if (Object.keys(state.agents).length > 0) {
        decisions.value.push(toDecision(state))
      }
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

// The decision log sits beside a portrait canvas (a column is left free) and below a landscape one
// until the viewport is wide enough to hold both (see useStageLayout).
const { portrait, logBeside } = useStageLayout(aspectRatio)

// The renderer hasn't reported its shape yet: the session row, socket, and first header are still in
// flight, so the stage shows a loading indicator rather than the decision log it has no rows for.
// (Stays false when no renderer is registered — that's its own empty state.)
const stageLoading = computed(() => aspectRatio.value === null && !noRenderer.value)

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
  const environmentMeta = environments.find((e) => e.env_id === fetched.env_id) ?? null
  // The renderer reads the move-clock budget from `meta.human_timeout_ms`, which carries only the
  // environment default. Overlay the session's own resolved value (its override or that default) so a
  // session started with a custom human timeout shows the right clock. A copy, so the shared env-meta
  // object the registry hands out is not mutated. Only a session that carries one overrides; otherwise
  // the env default stands.
  meta.value =
    environmentMeta !== null && fetched.human_timeout_ms !== null
      ? { ...environmentMeta, human_timeout_ms: fetched.human_timeout_ms }
      : environmentMeta
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

  // Only a blind viewer needs the anonymous numbering, and only then does it apply; an operator (or a
  // closed season) sees real owner labels and skips the lookup.
  if (blindAttribution.value) {
    anonymousNumbers.value = await watchAgentNumbers(fetched.env_id).catch(() => ({}))
  }

  if (fetched.status === 'ended') {
    // Historical sessions have no live socket to attach to; the recording is the source of truth.
    await hydrateRecording(fetched)
    connection.value = 'closed'
    return
  }
  // A watch run (scripted) plays paced so a container that streams faster than real time still
  // animates at the environment's cadence and reveals game over only once the frames have played
  // out. A human session renders its owner's own move on arrival for immediate feedback, but a
  // turn-based env's `live_interval_ms` throttles the other seats' burst so it animates card-by-card.
  connect({
    pace: fetched.mode === 'scripted',
    // A realtime env paces by its step interval; a turn-based one (Hearts) declares a viewing cadence
    // so a scripted watch plays out at a watchable speed rather than the buffer's bare default.
    paceMs: playbackIntervalMs(meta.value),
    // Live human play throttles opponents' moves at the env's live cadence; null (realtime, or an env
    // that declares none) keeps the unbuffered on-arrival behaviour.
    liveMs: fetched.mode === 'human' ? liveIntervalMs(meta.value) : null,
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
    decisions.value = parsed.states.map(toDecision)
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
      :anonymous-numbers="anonymousNumbers"
    />

    <!-- End-of-session feedback appears only after termination, immediately above the game stage. -->
    <SessionRatings v-if="status === 'ended'" :session-id="id" />

    <div class="stage" :class="[portrait ? 'portrait' : 'landscape', logBeside ? 'beside' : 'below']">
      <section class="stage-canvas" aria-label="Environment">
        <div
          class="renderer-host"
          ref="hostEl"
          :style="
            aspectRatio !== null
              ? { aspectRatio: String(aspectRatio), '--stage-aspect': String(aspectRatio) }
              : undefined
          "
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
          <!-- The shared cross-environment game-over leaderboard, over the final frame, once a run
               finishes play. Skipped for a run that was stopped, idled out, or crashed, whose partial
               board no final standings should claim. -->
          <GameOverCard
            v-if="
              status === 'ended' &&
              lastState !== null &&
              !gameOverDismissed &&
              isCompletedOutcome(endReason)
            "
            :state="lastState"
            :header="header"
            :blind="blindAttribution"
            :viewer-id="me.me?.user_id"
            :anonymous-numbers="anonymousNumbers"
            @dismiss="gameOverDismissed = true"
          />
        </div>
        <UiEmptyState v-if="noRenderer">No renderer is registered for this environment yet.</UiEmptyState>
      </section>

      <div v-if="stageLoading" class="stage-log stage-loading" role="status">
        <span class="overlay-spinner" aria-hidden="true" />
        <span>Loading session…</span>
      </div>
      <section v-else-if="logBeside" class="stage-log" aria-label="Decision log">
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

/* Beside layout: the columns stretch to a common height so the log matches the canvas beside it. The
   column ratio splits on orientation — a portrait canvas is narrow (the log takes the rest), a
   landscape canvas dominates (a narrower log sits to its right). Explicit grid-column placement keeps
   the canvas in column 1 and the log in column 2 regardless of orientation. */
.stage.beside {
  align-items: stretch;
}

.stage.beside.portrait {
  grid-template-columns: minmax(0, 22rem) minmax(0, 1fr);
}

.stage.beside.landscape {
  grid-template-columns: minmax(0, 1fr) minmax(0, 16rem);
}

.stage.beside .stage-canvas {
  grid-column: 1;
}

/* The decision log and the load-time spinner (which carries .stage-log too) take the second column. */
.stage.beside .stage-log {
  grid-column: 2;
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
  margin: 0 auto;
  background: var(--color-stage-backdrop);
  border-radius: var(--radius-md);
  overflow: hidden;
}

/* Portrait (Flappy Bird) keeps its exact width cap so it never grows absurdly tall. */
.stage.portrait .renderer-host {
  max-width: 480px;
}

/* Landscape (Hearts) grows to fill its column, but never taller than the fold. The cap is a width, not
   a height, derived from the fold height times the canvas aspect ratio (--stage-aspect, set inline from
   the renderer's reported ratio): capping width preserves the 4:3 shape instead of letterboxing it, so
   the Pixi canvas (which scales from width) is never vertically clipped on a short viewport. */
.stage.landscape .renderer-host {
  max-width: calc(min(70vh, 640px) * var(--stage-aspect, 1.333));
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

.stage-log-below {
  width: 100%;
  max-width: 480px;
}

/* A landscape canvas in the stacked layout is wider than 480px, so its collapsed log matches it. */
.stage.below.landscape .stage-log-below {
  max-width: 100%;
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
