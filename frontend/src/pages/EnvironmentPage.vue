<!--
  Environment hub (the Overview tab): everything about one environment in one place — the description
  and metadata, the entry points into play and watch (gated by participation status), and the current
  released season's leaderboards with a link to the full Leaderboards page and season history. Laid out
  as a column of sections. The other per-environment surfaces live in the tab strip (ExperimentTabs.vue):
  replays in the Replays tab, submissions in My Submissions, the operator console in Manage.

  The play and watch entry points stay visible for an anonymous visitor and route to the sign-in
  page when clicked; only a signed-in but still-pending account has them hidden. The backend
  enforces the participation gate either way, so the UI state is courtesy and the backend check is
  the enforcement.
  Each entry point opens the start form in a modal dialog (a short interruption — seed, timeout,
  confirm — not a destination), keeping the hub stable underneath. Starting resolves to a session id
  this page navigates to; the already-active case offers rejoin by navigating to the user's existing
  session instead of dead-ending.
-->
<script setup lang="ts">
import { resolveLayout } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import {
  type EnvironmentLeaderboards,
  getEnvironmentLeaderboards,
  getPlayParameters,
  getSeasonSettings,
  type EnvironmentSeasonSettings,
  listReleasedSeasons,
  listSeasons,
  listWatchAgents,
  type PlayParameters,
  type PublicSeasonView,
  type SeasonView,
  type StartPayload,
  startSession,
  type WatchAgentSummary,
} from '../api/client.js'
import LeaderboardBoards from '../components/LeaderboardBoards.vue'
import InlineMarkdown from '../components/InlineMarkdown.vue'
import SeasonChanges from '../components/SeasonChanges.vue'
import SeatAssignmentDialog from '../components/SeatAssignmentDialog.vue'
import StartForm from '../components/StartForm.vue'
import WatchAgentPicker from '../components/WatchAgentPicker.vue'
import UiBadge from '../components/ui/UiBadge.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiDialog from '../components/ui/UiDialog.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { useEnvironmentMeta } from '../composables/useEnvironmentMeta.js'
import { formatDate, formatSeasonName, seatLabel } from '../lib/format.js'
import { handleSessionStartResult } from '../lib/session-start.js'
import { canParticipate, isAdmin, useMe } from '../me.js'
import { thumbnailFor } from '../renderers/registry.js'

const route = useRoute()
const router = useRouter()
const me = useMe()
const envId = String(route.params.envId)

const { meta, notFound, loading } = useEnvironmentMeta(envId)
const startError = ref<string | null>(null)

// The current released boards for the embed below. An unreleased season's boards never appear because
// this public read returns released results only. The play gate comes from playParameters separately.
const leaderboards = ref<EnvironmentLeaderboards | null>(null)
// The environment's released seasons, newest first — the season record under the boards. Independent
// of the current-boards read so a failure of either leaves the other intact.
const releasedSeasons = ref<SeasonView[]>([])
// Public watch/play is enabled only when a season is the game's play-open target. Released history
// stays readable regardless, so the boards embed below is independent of this gate.
const playParameters = ref<PlayParameters | null>(null)
// A failed prefill read is not the same fact as a closed play window, and saying "no season is open"
// for a request that never landed would misreport the season's state, so track the failure separately
// and let the empty state say which one happened.
const playParametersFailed = ref(false)
// The season-settings document is presentation-only. Start forms still use the narrower play prefill
// endpoint, which remains the source of truth for a live session launch.
const seasonSettings = ref<EnvironmentSeasonSettings | null>(null)
const playSeasonSettings = computed(() => {
  const settings = seasonSettings.value?.play
  if (settings === null || settings === undefined) {
    return null
  }
  return settings.season_id === playParameters.value?.season_id ? settings : null
})
const playOpen = computed(
  () => playParameters.value !== null && playParameters.value.season_id !== null,
)
const activePlayParameters = computed(() => {
  const value = playParameters.value
  return value?.season_id === null || value === null
    ? null
    : { seasonId: value.season_id, parameters: value.values }
})

// The play-open season's active `ready` submissions, fetched once on the hub: the watch list rows and
// the watch/play seat-dropdown options both read from this one list.
// Null until it settles (empty when no season is play-open).
const watchAgents = ref<WatchAgentSummary[] | null>(null)

// This environment's public seasons, used to name the play-open season in the season section and in
// the peer play heading. The play prefill remains authoritative if this optional metadata read fails.
const publicSeasons = ref<PublicSeasonView[]>([])
const playableSeason = computed(() => {
  const seasonId = playParameters.value?.season_id
  return seasonId === null || seasonId === undefined
    ? null
    : publicSeasons.value.find((season) => season.id === seasonId) ?? null
})
// The peer play and rate section names the season its runs are played under, so the viewer knows
// which settings and which roster of agents they are watching and rating.
const playSectionHeading = computed(() =>
  playableSeason.value === null
    ? 'Play and Rate'
    : `Play and Rate: ${formatSeasonName(playableSeason.value)}`,
)

// The last released season — the one whose boards are embedded below, named in the section heading
// ("Leaderboard: <season>"); with nothing released the heading stays the plain plural.
const releasedSeason = computed(() => leaderboards.value?.current?.season ?? null)
// The released season and the settings its boards were played under, for the summary in the boards
// section. When the open play season is also the released season, that summary belongs beside the
// play entry point instead; if the optional play-settings read fails, this copy stays as the fallback.
const releasedSeasonSummary = computed(() => {
  const current = leaderboards.value?.current ?? null
  return current === null || current.season.id === playSeasonSettings.value?.season_id ? null : current
})
const boardsHeading = computed(() =>
  releasedSeason.value === null
    ? 'Leaderboards'
    : `Leaderboard: ${formatSeasonName(releasedSeason.value)}`,
)

// The released history minus the season already shown in the embedded boards section;
// these are the older seasons whose boards you reach by clicking through.
const pastSeasons = computed(() =>
  releasedSeasons.value.filter((s) => s.id !== releasedSeason.value?.id),
)

onMounted(() => {
  getEnvironmentLeaderboards(envId).then(
    (data) => {
      leaderboards.value = data
    },
    () => {
      // A failed read leaves only the released boards empty. Play remains governed by its prefill.
    },
  )
  listSeasons(envId).then(
    (seasons) => {
      publicSeasons.value = seasons
    },
    () => {
      // A failed read leaves optional banner details and the submission-season badge off.
    },
  )
  listReleasedSeasons(envId).then(
    (seasons) => {
      releasedSeasons.value = seasons
    },
    () => {
      // A failed read leaves the season record empty rather than breaking the hub.
    },
  )
  listWatchAgents(envId).then(
    (rows) => {
      watchAgents.value = rows
    },
    () => {
      // A failed read leaves an empty list: the watch section shows its empty state and a multi-seat
      // play dialog still offers the Naive baseline for every seat.
      watchAgents.value = []
    },
  )
  getPlayParameters(envId).then(
    (values) => {
      playParameters.value = values
      playParametersFailed.value = false
    },
    () => {
      playParameters.value = null
      playParametersFailed.value = true
    },
  )
  getSeasonSettings(envId).then(
    (settings) => {
      seasonSettings.value = settings
    },
    () => {
      // The play flow remains usable when this supplementary explanatory read fails.
    },
  )
})
// The play start dialog's open state. Watch starts through WatchAgentPicker, so this dialog is the
// human-play entry point only.
const playFormOpen = ref(false)
const canStartHumanPlay = computed(
  () => canParticipate(me.me) && Boolean(meta.value?.human_players.length && playOpen.value),
)
// The season-banner button also renders for an anonymous visitor, as the entry point into signing in:
// open() routes them to /login instead of opening the start dialog.
const showHumanPlay = computed(
  () =>
    (canParticipate(me.me) || me.me?.user == null) &&
    Boolean(meta.value?.human_players.length && playOpen.value),
)
// A multi-seat environment (Hearts) plays through the seat-assignment grid: the human claims a seat
// and agents fill the rest. A single-player environment (Flappy Bird) keeps the minimal start form.
const multiSeat = computed(
  () =>
    meta.value !== null &&
    playParameters.value !== null &&
    resolveLayout(meta.value, playParameters.value.values).seatCount > 1,
)

/** Remove a consumed play deep-link without discarding unrelated query parameters. */
function clearPlayQuery(): void {
  if (route.query.play !== '1') {
    return
  }
  const query = { ...route.query }
  delete query.play
  void router.replace({ path: route.path, query, hash: route.hash })
}

// Closing the dialog (escape, overlay, cancel) clears the open flag and any prior error in one place.
const dialogOpen = computed({
  get: () => playFormOpen.value,
  set: (open) => {
    playFormOpen.value = open
    if (!open) {
      startError.value = null
      clearPlayQuery()
    }
  },
})
const dialogTitle = computed(() =>
  meta.value === null
    ? ''
    : `Play ${meta.value.display_name}${
        playableSeason.value === null ? '' : `: ${formatSeasonName(playableSeason.value)}`
      }`,
)

const paceLabel = computed(() => {
  const ms = meta.value?.pace_interval_ms
  return ms === null || ms === undefined ? null : `paced ${ms} ms`
})

function open(): void {
  if (me.me?.user == null) {
    void router.push('/login')
    return
  }
  startError.value = null
  playFormOpen.value = true
}

// A season card or badge can deep-link to the existing play flow. Wait for identity, environment
// metadata, and the play-open target to resolve before opening the dialog.
watch(
  [() => route.query.play, canStartHumanPlay],
  ([play, canPlay]) => {
    if (play === '1' && canPlay) {
      open()
    }
  },
  { immediate: true },
)

/** The single-seat start form fills only the lone human seat; the backend derives the human mode. */
function startSingleSeat(input: Omit<StartPayload, 'seats'>): void {
  void submitStart({ seats: { seat_0: { kind: 'human' } }, ...input })
}

/** Start the human-play session the form (single seat) or seat grid (multi-seat) composed. */
async function submitStart(payload: StartPayload): Promise<void> {
  if (meta.value === null || !playFormOpen.value) {
    return
  }
  startError.value = null
  const result = await startSession({ envId: meta.value.env_id, ...payload })
  startError.value = await handleSessionStartResult(result, router)
}
</script>

<template>
  <UiEmptyState v-if="notFound" tone="danger">No such environment.</UiEmptyState>
  <UiEmptyState v-else-if="loading || meta === null">Loading…</UiEmptyState>
  <section v-else class="env">
    <header class="env-header">
      <div class="env-headline">
        <div class="env-title-row">
          <h1>{{ meta.display_name }}</h1>
          <UiBadge>{{ seatLabel(meta) }}</UiBadge>
          <UiBadge v-if="paceLabel !== null">{{ paceLabel }}</UiBadge>
        </div>
        <p class="env-description">{{ meta.description }}</p>
      </div>
      <img class="env-thumb" :src="thumbnailFor(meta.renderer)" alt="" />
    </header>

    <section v-if="playOpen" class="env-section">
      <div class="env-section-head">
        <div class="env-section-title">
          <h2>{{ playableSeason === null ? 'Open for Play' : 'Open for Play: ' + formatSeasonName(playableSeason) }}</h2>
        </div>
        <UiButton v-if="showHumanPlay" @click="open()" class="tight">Play</UiButton>
      </div>
      <div
        v-if="playableSeason !== null && playableSeason.description_markdown !== null"
      >
        <InlineMarkdown :markdown="playableSeason.description_markdown" />
      </div>
      <SeasonChanges
        v-if="playSeasonSettings !== null"
        :meta="meta"
        :settings="playSeasonSettings"
        context="play season"
        :season="{ id: playSeasonSettings.season_id, label: playSeasonSettings.season_label }"
      />
    </section>

    <section id="play" class="env-section">
      <div class="env-section-title">
        <h2>{{ playSectionHeading }}</h2>
      </div>
      <WatchAgentPicker
        v-if="playOpen && playParameters !== null && playParameters.season_id !== null"
        :env-id="meta.env_id"
        :meta="meta"
        :agents="watchAgents"
        :season-id="playParameters.season_id"
        :parameters="playParameters.values"
        :season-label="playableSeason === null ? undefined : formatSeasonName(playableSeason)"
      />
      <UiEmptyState v-else-if="playParametersFailed">
        The play settings for this environment could not be loaded. Refresh to try again.
      </UiEmptyState>
      <UiEmptyState v-else>No season is currently open for play.</UiEmptyState>
    </section>

    <section class="env-section">
      <div class="env-section-head">
        <div class="env-section-title">
          <h2>{{ boardsHeading }}</h2>
          <span v-if="releasedSeason?.released_at != null" class="env-section-season">
            released {{ formatDate(releasedSeason.released_at) }}
          </span>
        </div>
        <RouterLink class="env-section-link" :to="`/environments/${meta.env_id}/leaderboards`">
          View all &amp; history →
        </RouterLink>
      </div>
      <SeasonChanges
        v-if="releasedSeasonSummary !== null"
        :meta="meta"
        :settings="releasedSeasonSummary.settings"
        context="leaderboard season"
        :season="releasedSeasonSummary.season"
      />
      <LeaderboardBoards
        v-if="leaderboards?.current != null"
        :board="leaderboards.current.board"
        :env-id="meta.env_id"
        :rating-prompt="leaderboards.current.season.rating_prompt"
      />
      <UiEmptyState v-else>No released results for this environment yet.</UiEmptyState>

      <div v-if="pastSeasons.length > 0" class="env-season-record">
        <span class="env-season-record-label">Past seasons:</span>
        <RouterLink
          v-for="entry in pastSeasons"
          :key="entry.id"
          class="env-season-record-link"
          :to="`/environments/${meta.env_id}/leaderboards/${entry.id}`"
        >
          {{ formatSeasonName(entry) }}
        </RouterLink>
      </div>
    </section>

    <UiDialog v-model:open="dialogOpen" :title="dialogTitle">
      <SeatAssignmentDialog
        v-if="playFormOpen && multiSeat && activePlayParameters !== null"
        :meta="meta"
        :agents="watchAgents ?? []"
        mode="play"
        :is-operator="isAdmin(me.me)"
        :season-id="activePlayParameters.seasonId"
        :parameters="activePlayParameters.parameters"
        @start="submitStart"
        @cancel="playFormOpen = false"
      />
      <StartForm
        v-else-if="playFormOpen && activePlayParameters !== null"
        :meta="meta"
        :season-id="activePlayParameters.seasonId"
        :parameters="activePlayParameters.parameters"
        @submit="startSingleSeat"
        @cancel="playFormOpen = false"
      />
      <UiEmptyState v-if="startError !== null" tone="danger">{{ startError }}</UiEmptyState>
    </UiDialog>
  </section>
</template>

<style scoped>
.env-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-5);
}

.env-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin: 0 0 var(--space-2);
}

.env-headline h1 {
  margin: 0;
}

.env-description {
  margin: 0;
  color: var(--color-text-muted);
}

.env-thumb {
  width: 200px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  flex: none;
}

.env-section {
  margin-top: var(--space-6);
}

.env-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.env-section-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.env-section-title h2 {
  margin: 0;
}

.env-section-season {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.env-section-link {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  transition: color var(--motion-fast) var(--ease-out);
}

.env-section-link:hover {
  color: var(--color-accent);
}

.env-season-record {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-4);
  font-size: var(--text-sm);
}

.env-season-record-label {
  color: var(--color-text-muted);
}

.env-season-record-link {
  color: var(--color-accent);
}

.env-season-record-link:hover {
  color: var(--color-text);
}

/* The thumbnail drops below the description on narrow screens (the responsive pass). */
@media (max-width: 768px) {
  .env-header {
    flex-direction: column;
  }

  .env-thumb {
    width: 100%;
    max-width: 320px;
  }
}
</style>
