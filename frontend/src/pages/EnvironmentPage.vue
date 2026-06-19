<!--
  Environment hub: everything about one environment in one place — the description and metadata, the
  entry points into play and watch (gated by the allowlist), and the recent-replays list. Laid out as
  a column of sections that Stages 5 and 6 append to (submission form, leaderboards, season
  history); a quiet trailing sentence names that future rather than stubbing empty boxes.

  The play and watch entry points are hidden when `/api/me` says the user is not allowlisted, and the
  backend enforces the same gate, so the UI state is courtesy and the backend check is the enforcement.
  Each entry point opens the start form in a modal dialog (a short interruption — seed, timeout,
  confirm — not a destination), keeping the hub stable underneath. Starting resolves to a session id
  this page navigates to; the already-active case offers rejoin by navigating to the user's existing
  session instead of dead-ending.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { type EnvironmentLeaderboards, getEnvironmentLeaderboards, startSession } from '../api/client.js'
import LeaderboardBoards from '../components/LeaderboardBoards.vue'
import RecentReplays from '../components/RecentReplays.vue'
import StartForm from '../components/StartForm.vue'
import WatchAgentPicker from '../components/WatchAgentPicker.vue'
import UiBadge from '../components/ui/UiBadge.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiDialog from '../components/ui/UiDialog.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { useEnvironmentMeta } from '../composables/useEnvironmentMeta.js'
import { slotLabel } from '../lib/format.js'
import { useMe } from '../me.js'
import { thumbnailFor } from '../renderers/registry.js'

const route = useRoute()
const router = useRouter()
const me = useMe()
const envId = String(route.params.envId)

const { meta, notFound, loading } = useEnvironmentMeta(envId)
const startError = ref<string | null>(null)

// The current released boards plus the public play target. The boards embed and the watch/play gate
// read from this; an unreleased season's boards never appear (the public read only returns released
// results). Submission now lives on the Submit / My Agent tab (the agent profile), not on this hub.
const leaderboards = ref<EnvironmentLeaderboards | null>(null)
// Public watch/play is enabled only when a season is the game's play-open target. Released history
// stays readable regardless, so the boards embed below is independent of this gate.
const playOpen = computed(() => leaderboards.value?.play_season_id != null)

onMounted(() => {
  getEnvironmentLeaderboards(envId).then(
    (data) => {
      leaderboards.value = data
    },
    () => {
      // A failed read leaves the boards empty rather than breaking the hub, and keeps the play gate at
      // its safe-closed default (leaderboards stays null).
    },
  )
})
// The play start dialog's open state. Watch starts through WatchAgentPicker, so this dialog is the
// human-play entry point only.
const playFormOpen = ref(false)

// Closing the dialog (escape, overlay, cancel) clears the open flag and any prior error in one place.
const dialogOpen = computed({
  get: () => playFormOpen.value,
  set: (open) => {
    playFormOpen.value = open
    if (!open) {
      startError.value = null
    }
  },
})
const dialogTitle = computed(() => (meta.value === null ? '' : `Play ${meta.value.display_name}`))

const paceLabel = computed(() => {
  const ms = meta.value?.pace_interval_ms
  return ms === null || ms === undefined ? null : `paced ${ms} ms`
})

function open(): void {
  startError.value = null
  playFormOpen.value = true
}

async function start(input: { seed?: number; humanSlotTimeoutMs?: number }): Promise<void> {
  if (meta.value === null || !playFormOpen.value) {
    return
  }
  startError.value = null
  const result = await startSession({
    envId: meta.value.env_id,
    mode: 'human',
    seed: input.seed,
    humanSlotTimeoutMs: input.humanSlotTimeoutMs,
  })
  if (result.ok) {
    await router.push(`/sessions/${result.session.id}`)
  } else if (result.reason === 'already_active') {
    // Rejoin rather than dead-end: the user already has a session running.
    await router.push(`/sessions/${result.activeSessionId}`)
  } else if (result.reason === 'not_allowlisted') {
    startError.value = 'You are not on the session allowlist.'
  } else {
    startError.value = result.message
  }
}
</script>

<template>
  <UiEmptyState v-if="notFound" tone="danger">No such environment.</UiEmptyState>
  <UiEmptyState v-else-if="loading || meta === null">Loading…</UiEmptyState>
  <section v-else class="env">
    <p class="context-line">
      <RouterLink to="/">Environments</RouterLink>
      <span aria-hidden="true"> / </span>
      <span>{{ meta.display_name }}</span>
    </p>

    <header class="env-header">
      <div class="env-headline">
        <div class="env-title-row">
          <h1>{{ meta.display_name }}</h1>
          <UiButton
            v-if="me.me?.allowlisted && meta.human_slots.length > 0 && playOpen"
            size="lg"
            @click="open()"
          >
            Play Yourself
          </UiButton>
        </div>
        <p class="env-description">{{ meta.description }}</p>
        <div class="env-meta">
          <UiBadge>{{ slotLabel(meta) }}</UiBadge>
          <UiBadge v-if="meta.human_slots.length > 0" variant="accent">Human playable</UiBadge>
          <UiBadge v-if="paceLabel !== null">{{ paceLabel }}</UiBadge>
        </div>
      </div>
      <img class="env-thumb" :src="thumbnailFor(meta.renderer)" alt="" />
    </header>

    <section class="env-section">
      <h2>Watch an agent</h2>
      <WatchAgentPicker v-if="playOpen" :env-id="meta.env_id" />
      <UiEmptyState v-else>Public play is closed for this environment right now.</UiEmptyState>
    </section>

    <section class="env-section">
      <div class="env-section-head">
        <h2>Leaderboards</h2>
        <RouterLink class="env-section-link" :to="`/environments/${meta.env_id}/leaderboards`">
          View all &amp; history →
        </RouterLink>
      </div>
      <LeaderboardBoards
        v-if="leaderboards?.current != null"
        :board="leaderboards.current.board"
        :env-id="meta.env_id"
      />
      <UiEmptyState v-else>No released results for this environment yet.</UiEmptyState>
    </section>

    <section class="env-section">
      <h2>Recent replays</h2>
      <RecentReplays :env-id="meta.env_id" />
    </section>

    <UiDialog v-model:open="dialogOpen" :title="dialogTitle">
      <StartForm v-if="playFormOpen" :meta="meta" @submit="start" @cancel="playFormOpen = false" />
      <UiEmptyState v-if="startError !== null" tone="danger">{{ startError }}</UiEmptyState>
    </UiDialog>
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
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
}

.env-meta {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
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

.env-section-link {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  transition: color var(--motion-fast) var(--ease-out);
}

.env-section-link:hover {
  color: var(--color-accent);
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
