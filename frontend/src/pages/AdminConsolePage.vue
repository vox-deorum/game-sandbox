<!--
  The operator admin console (Stage 6.7): the operator-only surface that drives the step-3 admin API
  for one environment. It is gated by the `me` answer — the route and its entry point render only when
  `me.is_operator` — but the backend admin guard is the real authority; this UI gate just avoids
  showing dead controls. A non-operator who reaches the route sees an access notice, not the console.

  The console lets the operator declare and configure an iteration's match design, set the iteration's
  always-editable rating prompt, drive the three independent lifecycle gates (submissions, public play,
  release), trigger and re-run the workflow while watching its container logs stream live, and inspect
  the unreleased boards before releasing them — the verify-before-expose flow. Declaring creates an
  unreleased, submission-closed, play-closed iteration, so the console keeps opening submissions,
  opening public play, and releasing results visibly separate.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  type AdminIterationView,
  declareIteration,
  getAdminIteration,
  type IterationView,
  listAdminIterations,
} from '../api/client.js'
import IterationConfigEditor from '../components/admin/IterationConfigEditor.vue'
import IterationLifecycleControls from '../components/admin/IterationLifecycleControls.vue'
import OperatorRatingPromptEditor from '../components/admin/OperatorRatingPromptEditor.vue'
import RunPanel from '../components/admin/RunPanel.vue'
import LeaderboardBoards from '../components/LeaderboardBoards.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiInput from '../components/ui/UiInput.vue'
import { useEnvironmentMeta } from '../composables/useEnvironmentMeta.js'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'

const route = useRoute()
const me = useMe()
const envId = String(route.params.envId)
const { meta } = useEnvironmentMeta(envId)

type Access = 'loading' | 'denied' | 'ready'
const access = ref<Access>('loading')

const iterations = ref<IterationView[]>([])
const selectedId = ref<string | null>(null)
const view = ref<AdminIterationView | null>(null)
const loadingDetail = ref(false)
const declaring = ref(false)
const newLabel = ref('')
// Monotonically identifies the newest detail request. A slower response for a previously selected
// iteration must never replace the controls for the iteration the sidebar now highlights.
let detailRequest = 0

onMounted(async () => {
  // The console route is operator-only. Wait for the single /api/me answer, then gate. The backend
  // admin routes enforce the same gate, so a non-operator who forces the URL still gets nothing.
  await me.whenSettled()
  if (!me.me?.is_operator) {
    access.value = 'denied'
    return
  }
  access.value = 'ready'
  await loadIterations()
})

async function loadIterations(): Promise<void> {
  iterations.value = await listAdminIterations(envId)
  if (selectedId.value === null && iterations.value.length > 0) {
    selectedId.value = iterations.value[0]!.id
  }
  if (selectedId.value !== null) {
    await loadDetail()
  }
}

async function loadDetail(): Promise<void> {
  const iterationId = selectedId.value
  if (iterationId === null) {
    return
  }
  const requestId = ++detailRequest
  loadingDetail.value = true
  try {
    const loaded = await getAdminIteration(iterationId)
    if (requestId === detailRequest && selectedId.value === iterationId) {
      view.value = loaded
    }
  } finally {
    if (requestId === detailRequest) {
      loadingDetail.value = false
    }
  }
}

async function select(id: string): Promise<void> {
  if (id === selectedId.value) {
    return
  }
  selectedId.value = id
  // Hide the previous iteration's destructive controls while the new detail is in flight.
  view.value = null
  await loadDetail()
}

/** Reload both the picker (labels/gates may have changed) and the selected iteration's detail. */
async function refresh(updated?: IterationView): Promise<void> {
  if (updated !== undefined && view.value !== null) {
    view.value = { ...view.value, iteration: updated }
  }
  iterations.value = await listAdminIterations(envId)
  await loadDetail()
}

async function declare(): Promise<void> {
  declaring.value = true
  try {
    const label = newLabel.value.trim()
    const iteration = await declareIteration(envId, label === '' ? {} : { label })
    newLabel.value = ''
    selectedId.value = iteration.id
    await loadIterations()
  } finally {
    declaring.value = false
  }
}

function iterationLabel(iteration: IterationView): string {
  return iteration.label ?? `Iteration ${iteration.id.slice(0, 8)}`
}
</script>

<template>
  <section class="admin">
    <p class="context-line">
      <RouterLink to="/">Environments</RouterLink>
      <span aria-hidden="true"> / </span>
      <RouterLink :to="`/environments/${envId}`">{{ meta?.display_name ?? envId }}</RouterLink>
      <span aria-hidden="true"> / </span>
      <span>Admin console</span>
    </p>

    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      The admin console is limited to operators.
    </UiEmptyState>

    <template v-else>
      <header class="admin-header">
        <h1>Admin console</h1>
        <p class="admin-sub">{{ meta?.display_name ?? envId }}</p>
      </header>

      <div class="admin-body">
        <aside class="admin-sidebar" aria-label="Iterations">
          <div class="declare">
            <UiInput v-model="newLabel" type="text" placeholder="New iteration label (optional)" />
            <UiButton :loading="declaring" @click="declare">Declare iteration</UiButton>
          </div>
          <p class="declare-note">
            Declaring creates an unreleased, submission-closed, play-closed iteration. Opening
            submissions, opening play, and releasing are separate actions.
          </p>
          <ul class="iteration-list">
            <li v-for="iteration in iterations" :key="iteration.id">
              <button
                type="button"
                class="iteration-button"
                :class="{ selected: iteration.id === selectedId }"
                @click="select(iteration.id)"
              >
                <span class="iteration-name">{{ iterationLabel(iteration) }}</span>
                <span class="iteration-gates">
                  {{ iteration.release_status === 'released' ? 'released' : 'unreleased' }} ·
                  sub {{ iteration.submission_status }} · play {{ iteration.play_status }}
                </span>
              </button>
            </li>
          </ul>
          <UiEmptyState v-if="iterations.length === 0">
            No iterations yet. Declare one to begin.
          </UiEmptyState>
        </aside>

        <main class="admin-main">
          <UiEmptyState v-if="selectedId === null">
            Select or declare an iteration to configure it.
          </UiEmptyState>
          <UiEmptyState v-else-if="view === null && loadingDetail">Loading…</UiEmptyState>
          <template v-else-if="view !== null">
            <UiCard class="admin-card">
              <div class="card-head">
                <h2>{{ iterationLabel(view.iteration) }}</h2>
                <span v-if="view.iteration.released_at !== null" class="card-meta">
                  released {{ formatDate(view.iteration.released_at) }}
                </span>
              </div>
              <IterationLifecycleControls :iteration="view.iteration" @changed="refresh" />
            </UiCard>

            <UiCard class="admin-card">
              <IterationConfigEditor :iteration="view.iteration" @changed="refresh" />
            </UiCard>

            <OperatorRatingPromptEditor
              class="admin-card"
              :iteration="view.iteration"
              @changed="refresh"
            />

            <UiCard class="admin-card">
              <h2 class="card-title">Run</h2>
              <RunPanel
                :iteration="view.iteration"
                :latest-run="view.latest_run"
                @changed="loadDetail"
              />
            </UiCard>

            <UiCard class="admin-card">
              <h2 class="card-title">Boards</h2>
              <p v-if="view.iteration.release_status !== 'released'" class="card-meta">
                These boards are operator-only until you release the iteration.
              </p>
              <LeaderboardBoards :board="view.board" :env-id="envId" />
            </UiCard>
          </template>
        </main>
      </div>
    </template>
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

.admin-header h1 {
  margin: 0 0 var(--space-1);
}

.admin-sub {
  margin: 0 0 var(--space-5);
  color: var(--color-text-muted);
}

.admin-body {
  display: grid;
  grid-template-columns: 16rem 1fr;
  gap: var(--space-6);
  align-items: start;
}

.declare {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.declare-note {
  margin: var(--space-2) 0 var(--space-4);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.iteration-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.iteration-button {
  width: 100%;
  text-align: left;
  font: inherit;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  transition: border-color var(--motion-fast) var(--ease-out);
}

.iteration-button:hover {
  border-color: var(--color-border-strong);
}

.iteration-button.selected {
  border-color: var(--color-accent);
}

.iteration-name {
  font-weight: 600;
}

.iteration-gates {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.admin-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.admin-card {
  margin: 0;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.card-head h2,
.card-title {
  margin: 0;
  font-size: var(--text-lg);
}

.card-title {
  margin-bottom: var(--space-3);
}

.card-meta {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

@media (max-width: 768px) {
  .admin-body {
    grid-template-columns: 1fr;
  }
}
</style>
