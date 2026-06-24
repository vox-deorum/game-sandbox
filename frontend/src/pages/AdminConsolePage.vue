<!--
  The operator admin console (Stage 6.7): the operator-only surface that drives the step-3 admin API
  for one environment. It is gated by the `me` answer — the route and its entry point render only when
  `me.is_operator` — but the backend admin guard is the real authority; this UI gate just avoids
  showing dead controls. A non-operator who reaches the route sees an access notice, not the console.

  The console lets the operator declare and configure a season's match design, set the season's
  always-editable rating prompt, drive the three independent lifecycle gates (submissions, public play,
  release), trigger and re-run the workflow while watching its container logs stream live, and inspect
  the unreleased boards before releasing them — the verify-before-expose flow. Declaring creates an
  unreleased, submission-closed, play-closed season, so the console keeps opening submissions,
  opening public play, and releasing results visibly separate.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import {
  type AdminSeasonView,
  declareSeason,
  getAdminSeason,
  listRuns,
  listSeasons,
  type PublicSeasonView,
  renameSeason,
  type RunSummaryView,
  type SeasonView,
} from '../api/client.js'
import SeasonConfigEditor from '../components/admin/SeasonConfigEditor.vue'
import SeasonLifecycleControls from '../components/admin/SeasonLifecycleControls.vue'
import OperatorRatingPromptEditor from '../components/admin/OperatorRatingPromptEditor.vue'
import RunActions from '../components/admin/RunActions.vue'
import RunsList from '../components/admin/RunsList.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiInput from '../components/ui/UiInput.vue'
import { useEnvironmentMeta } from '../composables/useEnvironmentMeta.js'
import { useMe } from '../me.js'

const route = useRoute()
const me = useMe()
const envId = String(route.params.envId)
const { meta } = useEnvironmentMeta(envId)

type Access = 'loading' | 'denied' | 'ready'
const access = ref<Access>('loading')

const seasons = ref<PublicSeasonView[]>([])
const selectedId = ref<string | null>(null)
const view = ref<AdminSeasonView | null>(null)
// The selected season's runs, newest first, for the runs list. Loaded alongside the detail view.
const runs = ref<RunSummaryView[]>([])
const loadingDetail = ref(false)
// A board exists to inspect only once a run has computed one; before that the link is disabled.
const boardAvailable = computed(
  () => (view.value?.board.automated.length ?? 0) > 0 || (view.value?.board.human.length ?? 0) > 0,
)
const declaring = ref(false)
const newLabel = ref('')
// Unsaved match-design edits in the config editor gate "Run workflow": a run reads the persisted
// config, so triggering on an unsaved draft would silently run the old (often empty) design.
const configDirty = ref(false)
// Inline rename of the selected season: opens with the current label, saves through the admin API.
const renaming = ref(false)
const renameLabel = ref('')
const savingRename = ref(false)
const renameError = ref<string | null>(null)
// Monotonically identifies the newest detail request. A slower response for a previously selected
// season must never replace the controls for the season the sidebar now highlights.
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
  await loadSeasons()
})

async function loadSeasons(): Promise<void> {
  seasons.value = await listSeasons(envId, { includeUnreleased: true })
  if (selectedId.value === null && seasons.value.length > 0) {
    selectedId.value = seasons.value[0]!.id
  }
  if (selectedId.value !== null) {
    await loadDetail()
  }
}

async function loadDetail(): Promise<void> {
  const seasonId = selectedId.value
  if (seasonId === null) {
    return
  }
  const requestId = ++detailRequest
  loadingDetail.value = true
  try {
    const [loaded, loadedRuns] = await Promise.all([getAdminSeason(seasonId), listRuns(seasonId)])
    if (requestId === detailRequest && selectedId.value === seasonId) {
      view.value = loaded
      runs.value = loadedRuns
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
  // Hide the previous season's destructive controls (and any open rename) while the new detail loads.
  view.value = null
  runs.value = []
  renaming.value = false
  await loadDetail()
}

/** Reload both the picker (labels/gates may have changed) and the selected season's detail. */
async function refresh(updated?: SeasonView): Promise<void> {
  if (updated !== undefined && view.value !== null) {
    view.value = { ...view.value, season: updated }
  }
  seasons.value = await listSeasons(envId, { includeUnreleased: true })
  await loadDetail()
}

async function declare(): Promise<void> {
  declaring.value = true
  try {
    const label = newLabel.value.trim()
    const season = await declareSeason(envId, label === '' ? {} : { label })
    newLabel.value = ''
    selectedId.value = season.id
    await loadSeasons()
  } finally {
    declaring.value = false
  }
}

function seasonLabel(season: { id: string; label: string | null }): string {
  return season.label ?? `Season: ${season.id.slice(0, 8)}`
}

// The detail heading reads "Season <label>" for a named season; an unnamed one already falls back to
// "Season <id>", so prefix only the named case to avoid a doubled "Season Season …".
function seasonHeading(season: SeasonView): string {
  return season.label === null ? seasonLabel(season) : `Season ${season.label}`
}

function startRename(season: SeasonView): void {
  renameLabel.value = season.label ?? ''
  renameError.value = null
  renaming.value = true
}

function cancelRename(): void {
  renaming.value = false
}

async function saveRename(seasonId: string): Promise<void> {
  savingRename.value = true
  renameError.value = null
  try {
    const label = renameLabel.value.trim()
    const result = await renameSeason(seasonId, label === '' ? null : label)
    if (result.ok) {
      renaming.value = false
      await refresh(result.season)
    } else {
      renameError.value =
        result.reason === 'too_long'
          ? 'That name is too long (100 characters max).'
          : 'Could not rename the season.'
    }
  } finally {
    savingRename.value = false
  }
}
</script>

<template>
  <section class="admin">
    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      The admin console is limited to operators.
    </UiEmptyState>

    <template v-else>
      <header class="admin-header">
        <h1>Season Management</h1>
      </header>

      <div class="admin-body">
        <aside class="admin-sidebar" aria-label="Seasons">
          <div class="declare">
            <UiInput v-model="newLabel" type="text" placeholder="New season label (optional)" />
            <UiButton :loading="declaring" @click="declare">Declare season</UiButton>
          </div>
          <p class="declare-note">
            Declaring creates an unreleased, submission-closed, play-closed season. Opening
            submissions, opening play, and releasing are separate actions.
          </p>
          <ul class="season-list">
            <li v-for="season in seasons" :key="season.id">
              <button
                type="button"
                class="season-button"
                :class="{ selected: season.id === selectedId }"
                @click="select(season.id)"
              >
                <span class="season-name">{{ seasonLabel(season) }}</span>
                <span class="season-gates">
                  {{ season.release_status === 'released' ? 'released' : 'unreleased' }} ·
                  sub {{ season.submission_status }} · play {{ season.play_status }}
                </span>
              </button>
            </li>
          </ul>
          <UiEmptyState v-if="seasons.length === 0">
            No seasons yet. Declare one to begin.
          </UiEmptyState>
        </aside>

        <main class="admin-main">
          <UiEmptyState v-if="selectedId === null">
            Select or declare a season to configure it.
          </UiEmptyState>
          <UiEmptyState v-else-if="view === null && loadingDetail">Loading…</UiEmptyState>
          <template v-else-if="view !== null">
            <section class="admin-section">
              <div class="section-head">
                <template v-if="renaming">
                  <form class="rename" @submit.prevent="saveRename(view.season.id)">
                    <UiInput
                      v-model="renameLabel"
                      type="text"
                      aria-label="Season name"
                      placeholder="Season name"
                    />
                    <UiButton type="submit" size="tight" :loading="savingRename">Save</UiButton>
                    <UiButton type="button" variant="secondary" size="tight" @click="cancelRename">
                      Cancel
                    </UiButton>
                  </form>
                </template>
                <template v-else>
                  <h2>{{ seasonHeading(view.season) }}</h2>
                  <UiButton variant="secondary" size="tight" @click="startRename(view.season)">
                    Rename
                  </UiButton>
                </template>
              </div>
              <p v-if="renameError" class="rename-error" role="alert">{{ renameError }}</p>
              <UiCard class="admin-card">
                <SeasonLifecycleControls :season="view.season" @changed="refresh" />
              </UiCard>
            </section>

            <RunActions
              :season="view.season"
              :latest-run="view.latest_run"
              :env-id="envId"
              :board-available="boardAvailable"
              :config-dirty="configDirty"
              @changed="loadDetail"
            />

            <section class="admin-section">
              <h2>Run Configuration</h2>
              <UiCard class="admin-card">
                <SeasonConfigEditor
                  :season="view.season"
                  @changed="refresh"
                  @dirty-change="configDirty = $event"
                />
              </UiCard>
            </section>

            <section class="admin-section">
              <h2>Human Rating Prompt</h2>
              <UiCard class="admin-card">
                <OperatorRatingPromptEditor :season="view.season" @changed="refresh" />
              </UiCard>
            </section>

            <section class="admin-section">
              <h2>Archived Runs</h2>
              <RunsList :runs="runs" :env-id="envId" :season-id="view.season.id" />
            </section>
          </template>
        </main>
      </div>
    </template>
  </section>
</template>

<style scoped>
.admin-header h1 {
  margin: 0 0 var(--space-1);
}

.admin-body {
  display: grid;
  grid-template-columns: 1fr 16rem;
  gap: var(--space-6);
  align-items: start;
}

/* The seasons sidebar stays first in the DOM (it is the section's navigation) but sits in the right
   column; the configuration main fills the wider left column. */
.admin-sidebar {
  grid-column: 2;
  grid-row: 1;
}

.admin-main {
  grid-column: 1;
  grid-row: 1;
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

.season-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.season-button {
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

.season-button:hover {
  border-color: var(--color-border-strong);
}

.season-button.selected {
  border-color: var(--color-accent);
}

.season-name {
  font-weight: 600;
}

.season-gates {
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

.admin-section h2 {
  margin: 0 0 var(--space-4);
  font-size: var(--text-lg);
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.section-head h2 {
  margin: 0;
}

.rename {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
}

.rename-error {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-danger);
}

@media (max-width: 768px) {
  .admin-body {
    grid-template-columns: 1fr;
  }

  /* Stacked: drop the explicit placement so the columns flow in DOM order (sidebar, then main). */
  .admin-sidebar,
  .admin-main {
    grid-column: auto;
    grid-row: auto;
  }
}
</style>
