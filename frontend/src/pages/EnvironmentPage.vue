<!--
  Environment hub: everything about one environment in one place — the description and metadata, the
  entry points into play and watch (gated by the allowlist), and the recent-replays list. Laid out as
  a column of sections that Stages 5 and 6 append to (submission form, leaderboards, iteration
  history); a quiet trailing sentence names that future rather than stubbing empty boxes.

  The play and watch entry points are hidden when `/api/me` says the user is not allowlisted, and the
  backend enforces the same gate, so the UI state is courtesy and the backend check is the enforcement.
  Each entry point opens the start form in a modal dialog (a short interruption — seed, timeout,
  confirm — not a destination), keeping the hub stable underneath. Starting resolves to a session id
  this page navigates to; the already-active case offers rejoin by navigating to the user's existing
  session instead of dead-ending.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { startSession } from '../api/client.js'
import RecentReplays from '../components/RecentReplays.vue'
import StartForm from '../components/StartForm.vue'
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
// Which start form the dialog shows (Play opens human, Watch opens scripted); null when closed.
const formMode = ref<'human' | 'scripted' | null>(null)

// The dialog's open state is derived from formMode, so closing it (escape, overlay, cancel) clears
// the mode and any prior error in one place.
const dialogOpen = computed({
  get: () => formMode.value !== null,
  set: (open) => {
    if (!open) {
      formMode.value = null
      startError.value = null
    }
  },
})
const dialogTitle = computed(() =>
  meta.value === null ? '' : `${formMode.value === 'human' ? 'Play' : 'Watch'} ${meta.value.display_name}`,
)

const paceLabel = computed(() => {
  const ms = meta.value?.pace_interval_ms
  return ms === null || ms === undefined ? null : `paced ${ms} ms`
})

function open(mode: 'human' | 'scripted'): void {
  startError.value = null
  formMode.value = mode
}

async function start(input: { seed?: number; humanSlotTimeoutMs?: number }): Promise<void> {
  if (meta.value === null || formMode.value === null) {
    return
  }
  startError.value = null
  const result = await startSession({
    envId: meta.value.env_id,
    mode: formMode.value,
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
        <h1>{{ meta.display_name }}</h1>
        <p class="env-description">{{ meta.description }}</p>
        <div class="env-meta">
          <UiBadge>{{ slotLabel(meta) }}</UiBadge>
          <UiBadge v-if="meta.human_slots.length > 0" variant="accent">Human playable</UiBadge>
          <UiBadge v-if="paceLabel !== null">{{ paceLabel }}</UiBadge>
        </div>
      </div>
      <img class="env-thumb" :src="thumbnailFor(meta.renderer)" alt="" />
    </header>

    <div class="env-actions">
      <template v-if="me.me?.allowlisted">
        <UiButton v-if="meta.human_slots.length > 0" size="lg" @click="open('human')">Play</UiButton>
        <UiButton size="lg" variant="secondary" @click="open('scripted')">Watch</UiButton>
      </template>
      <UiEmptyState v-else>Live play is limited to allowlisted users.</UiEmptyState>
    </div>

    <section class="env-section">
      <h2>Recent replays</h2>
      <RecentReplays :env-id="meta.env_id" />
    </section>

    <p class="env-placeholder">Leaderboards and agent submissions arrive in later stages.</p>

    <UiDialog v-model:open="dialogOpen" :title="dialogTitle">
      <StartForm v-if="formMode !== null" :meta="meta" :mode="formMode" @submit="start" @cancel="formMode = null" />
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

.env-headline h1 {
  margin: 0 0 var(--space-2);
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

.env-actions {
  display: flex;
  gap: var(--space-3);
  margin: var(--space-5) 0;
}

.env-section {
  margin-top: var(--space-6);
}

.env-placeholder {
  margin-top: var(--space-6);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
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
