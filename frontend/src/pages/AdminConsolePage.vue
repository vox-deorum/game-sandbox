<!--
  The operator admin console (Stage 6.7): the operator-only surface that drives the step-3 admin API
  for one environment. It is gated by the `me` answer — the route and its entry point render only when
  `isAdmin(me)` — but the backend admin guard is the real authority; this UI gate just avoids
  showing dead controls. A non-operator who reaches the route sees an access notice, not the console.

  The console lets the operator declare and configure a season's match design, set the season's
  always-editable rating prompt, drive the three independent lifecycle gates (submissions, public play,
  release), trigger and re-run the workflow while watching its container logs stream live, and inspect
  the unreleased boards before releasing them — the verify-before-expose flow. Declaring creates an
  unreleased, submission-closed, play-closed season, so the console keeps opening submissions,
  opening public play, and releasing results visibly separate.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'

import { RATING_PROMPT_MAX, SEASON_DESCRIPTION_MAX } from '@game-sandbox/schema/seasons'

import {
  type AdminLlmDevelopmentUser,
  type AdminSeasonView,
  deleteSeason,
  declareSeason,
  getAdminSeason,
  type LlmDevelopmentCall,
  listAdminLlmDevelopmentCalls,
  listAdminLlmDevelopmentUsers,
  listRuns,
  listSeasons,
  type PublicSeasonView,
  renameSeason,
  type RunSummaryView,
  type SeasonView,
  setSeasonDescription,
  setSeasonRatingPrompt,
  setSeasonTemplateRepository,
} from '../api/client.js'
import DevelopmentCallHistoryDialog from '../components/DevelopmentCallHistoryDialog.vue'
import OperatorSeasonTextEditor from '../components/admin/OperatorSeasonTextEditor.vue'
import SeasonConfigEditor from '../components/admin/SeasonConfigEditor.vue'
import SeasonLifecycleControls from '../components/admin/SeasonLifecycleControls.vue'
import RunActions from '../components/admin/RunActions.vue'
import RunsList from '../components/admin/RunsList.vue'
import SeasonSubmissions from '../components/admin/SeasonSubmissions.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiDialog from '../components/ui/UiDialog.vue'
import UiDialogActions from '../components/ui/UiDialogActions.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiInput from '../components/ui/UiInput.vue'
import { useEnvironmentMeta } from '../composables/useEnvironmentMeta.js'
import { useLatestRequest } from '../composables/useLatestRequest.js'
import { formatLlmCost } from '../lib/llm.js'
import { isAdmin, useMe } from '../me.js'

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
const developmentUsers = ref<AdminLlmDevelopmentUser[] | null>(null)
const developmentUsersError = ref(false)
const loadingDetail = ref(false)
// A board exists to inspect only once a run has computed one; before that the link is disabled.
const boardAvailable = computed(
  () => (view.value?.board.automated.length ?? 0) > 0 || (view.value?.board.human.length ?? 0) > 0,
)
const declaring = ref(false)
const newLabel = ref('')
// Unsaved edits in the config editor make "Run workflow" prompt first: a run reads the persisted
// config, so triggering on an unsaved draft would otherwise silently run the old (often empty) design.
const configDirty = ref(false)
// Inline rename of the selected season: opens with the current label, saves through the admin API.
const renaming = ref(false)
const renameLabel = ref('')
const savingRename = ref(false)
const renameError = ref<string | null>(null)
const deleteOpen = ref(false)
const deleting = ref(false)
const deleteError = ref<string | null>(null)
// Monotonically identifies the newest detail request. A slower response for a previously selected
// season must never replace the controls for the season the sidebar now highlights.
const detailRequest = useLatestRequest()

onMounted(async () => {
  // The console route is operator-only. Wait for the single /api/me answer, then gate. The backend
  // admin routes enforce the same gate, so a non-operator who forces the URL still gets nothing.
  await me.whenSettled()
  if (!isAdmin(me.me)) {
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
  const isCurrent = detailRequest.begin()
  loadingDetail.value = true
  try {
    const [loaded, loadedRuns, loadedDevelopmentUsers] = await Promise.all([
      getAdminSeason(seasonId),
      listRuns(seasonId),
      listAdminLlmDevelopmentUsers(seasonId).then(
        (users) => ({ users, failed: false }),
        () => ({ users: [] as AdminLlmDevelopmentUser[], failed: true }),
      ),
    ])
    if (isCurrent() && selectedId.value === seasonId) {
      view.value = loaded
      runs.value = loadedRuns
      developmentUsers.value = loadedDevelopmentUsers.users
      developmentUsersError.value = loadedDevelopmentUsers.failed
    }
  } finally {
    if (isCurrent()) {
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
  developmentUsers.value = null
  developmentUsersError.value = false
  historyOpen.value = false
  closeDevelopmentHistory()
  renaming.value = false
  await loadDetail()
}

/** Reload both the picker (labels/gates may have changed) and the selected season's detail. */
async function refresh(updated?: SeasonView): Promise<void> {
  if (updated !== undefined && updated.id === selectedId.value && view.value !== null) {
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

function ratingPromptErrorMessage(reason: string): string {
  return reason === 'too_long'
    ? 'That prompt is too long.'
    : 'Could not save the rating prompt. Please try again.'
}

function seasonDescriptionErrorMessage(reason: string): string {
  return reason === 'too_long'
    ? 'That description is too long.'
    : reason === 'multiple_paragraphs'
      ? 'Use one paragraph only.'
      : 'Could not save the season description. Please try again.'
}

function templateRepositoryErrorMessage(reason: string): string {
  return reason === 'invalid'
    ? 'Enter a valid repository URL.'
    : 'Could not save the template repository. Please try again.'
}

function startRename(season: SeasonView): void {
  renameLabel.value = season.label ?? ''
  renameError.value = null
  renaming.value = true
}

function cancelRename(): void {
  renaming.value = false
}

function openDelete(): void {
  deleteError.value = null
  deleteOpen.value = true
}

function closeDelete(): void {
  if (!deleting.value) {
    deleteOpen.value = false
    deleteError.value = null
  }
}

/** Clear data that belongs to the previously selected season before choosing a replacement. */
function clearSelectedSeason(): void {
  detailRequest.invalidate()
  selectedId.value = null
  view.value = null
  runs.value = []
  developmentUsers.value = null
  developmentUsersError.value = false
  configDirty.value = false
  renaming.value = false
  historyOpen.value = false
  closeDevelopmentHistory()
}

async function confirmDelete(): Promise<void> {
  const seasonId = selectedId.value
  if (seasonId === null) {
    return
  }
  deleting.value = true
  deleteError.value = null
  try {
    const result = await deleteSeason(seasonId)
    if (result.ok) {
      deleteOpen.value = false
      clearSelectedSeason()
      await loadSeasons()
      return
    }
    deleteError.value =
      result.reason === 'season_not_deletable'
        ? 'Only closed, unreleased seasons can be deleted.'
        : result.reason === 'season_not_empty'
          ? 'This season has activity, so it cannot be deleted.'
          : result.reason === 'not_found'
            ? 'This season no longer exists. Reload the season list and try again.'
            : 'Could not delete the season. Try again.'
  } catch {
    deleteError.value = 'Could not delete the season. Try again.'
  } finally {
    deleting.value = false
  }
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

const historyOpen = ref(false)
const historyUserId = ref<string | null>(null)
const historyCalls = ref<LlmDevelopmentCall[]>([])
const historyNextCursor = ref<number | null>(null)
const historyLoading = ref(false)
const historyLoadingMore = ref(false)
const historyError = ref<string | null>(null)
const historyRequest = useLatestRequest()

async function openDevelopmentHistory(userId: string): Promise<void> {
  const seasonId = selectedId.value
  if (seasonId === null) {
    return
  }
  const isCurrent = historyRequest.begin()
  historyUserId.value = userId
  historyCalls.value = []
  historyNextCursor.value = null
  historyError.value = null
  historyOpen.value = true
  historyLoading.value = true
  try {
    const page = await listAdminLlmDevelopmentCalls(seasonId, userId, { limit: 25 })
    if (
      isCurrent() &&
      selectedId.value === seasonId &&
      historyUserId.value === userId
    ) {
      historyCalls.value = page.calls
      historyNextCursor.value = page.next_cursor
    }
  } catch {
    if (isCurrent()) {
      historyError.value = 'Could not load development call history.'
    }
  } finally {
    if (isCurrent()) {
      historyLoading.value = false
    }
  }
}

async function loadMoreDevelopmentHistory(cursor: number): Promise<void> {
  const seasonId = selectedId.value
  const userId = historyUserId.value
  if (seasonId === null || userId === null) {
    return
  }
  const isCurrent = historyRequest.begin()
  historyLoadingMore.value = true
  historyError.value = null
  try {
    const page = await listAdminLlmDevelopmentCalls(seasonId, userId, { cursor, limit: 25 })
    if (
      isCurrent() &&
      selectedId.value === seasonId &&
      historyUserId.value === userId
    ) {
      historyCalls.value = [...historyCalls.value, ...page.calls]
      historyNextCursor.value = page.next_cursor
    }
  } catch {
    if (isCurrent()) {
      historyError.value = 'Could not load more development calls.'
    }
  } finally {
    if (isCurrent()) {
      historyLoadingMore.value = false
    }
  }
}

function closeDevelopmentHistory(): void {
  historyRequest.invalidate()
  historyLoadingMore.value = false
  historyUserId.value = null
  historyCalls.value = []
  historyNextCursor.value = null
  historyError.value = null
}

onUnmounted(() => {
  detailRequest.invalidate()
  historyRequest.invalidate()
})
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
                  <div class="section-actions">
                    <UiButton variant="secondary" size="tight" @click="startRename(view.season)">
                      Rename
                    </UiButton>
                    <UiButton variant="danger" size="tight" @click="openDelete">
                      Delete season
                    </UiButton>
                  </div>
                </template>
              </div>
              <p v-if="renameError" class="rename-error" role="alert">{{ renameError }}</p>
              <UiCard class="admin-card">
                <SeasonLifecycleControls :season="view.season" @changed="refresh" />
                <OperatorSeasonTextEditor
                  :season="view.season"
                  field="description_markdown"
                  label="Season description"
                  save-label="Save description"
                  :max-length="SEASON_DESCRIPTION_MAX"
                  :persist="setSeasonDescription"
                  :error-message="seasonDescriptionErrorMessage"
                  :template-repository="view.season.template_repo_url"
                  :persist-template-repository="setSeasonTemplateRepository"
                  :template-repository-error-message="templateRepositoryErrorMessage"
                  clearable
                  clear-label="Clear description"
                  @changed="refresh"
                >
                  <p>
                    Up to {{ SEASON_DESCRIPTION_MAX.toLocaleString() }} characters. Inline
                    Markdown supports emphasis, strong text, inline code, and HTTP or HTTPS links.
                  </p>
                </OperatorSeasonTextEditor>
              </UiCard>
            </section>

            <section class="admin-section">
              <h2>Run Configuration</h2>
              <SeasonConfigEditor
                :season="view.season"
                :eligible-submission-count="view.eligible_submission_count"
                :environment="meta ?? undefined"
                @changed="refresh"
                @dirty-change="configDirty = $event"
              >
                <!-- The run controls share the editor's action row, next to Save configuration. -->
                <template #actions>
                  <RunActions
                    :season="view.season"
                    :latest-run="view.latest_run"
                    :env-id="envId"
                    :board-available="boardAvailable"
                    :config-dirty="configDirty"
                    @changed="loadDetail"
                  />
                </template>
              </SeasonConfigEditor>
            </section>

            <section class="admin-section">
              <h2>Human Rating Prompt</h2>
              <UiCard class="admin-card">
                <OperatorSeasonTextEditor
                  :season="view.season"
                  field="rating_prompt"
                  label="Rating prompt"
                  save-label="Save prompt"
                  :max-length="RATING_PROMPT_MAX"
                  :persist="setSeasonRatingPrompt"
                  :error-message="ratingPromptErrorMessage"
                  saved-label="Saved ✓"
                  @changed="refresh"
                >
                  <p>
                    Shown to human raters for every agent in this season. Each author can have their own
                    prompt.
                  </p>
                </OperatorSeasonTextEditor>
              </UiCard>
            </section>

            <section class="admin-section">
              <h2>Development usage</h2>
              <UiEmptyState v-if="developmentUsers === null">Loading…</UiEmptyState>
              <UiEmptyState v-else-if="developmentUsersError" tone="danger">
                Could not load development usage.
              </UiEmptyState>
              <UiEmptyState v-else-if="developmentUsers.length === 0">
                No development calls for this season.
              </UiEmptyState>
              <div v-else class="development-table-wrap">
                <table class="development-table">
                  <thead>
                    <tr>
                      <th scope="col">Participant</th>
                      <th scope="col" class="num">Calls used</th>
                      <th scope="col" class="num">Budget units used</th>
                      <th scope="col" class="num">Budget units remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="participant in developmentUsers"
                      :key="participant.user_id"
                      class="development-user-row"
                      @click="openDevelopmentHistory(participant.user_id)"
                    >
                      <td>
                        <button
                          type="button"
                          class="participant-history-button"
                          @click.stop="openDevelopmentHistory(participant.user_id)"
                        >
                          {{ participant.user_id }}
                        </button>
                      </td>
                      <td class="num">{{ participant.successful_calls }}</td>
                      <td class="num">{{ formatLlmCost(participant.budget_cost_units_used) }}</td>
                      <td class="num">
                        {{ formatLlmCost(participant.budget_cost_units_remaining) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section class="admin-section">
              <SeasonSubmissions :season-id="view.season.id" />
            </section>

            <section class="admin-section">
              <h2>Archived Runs</h2>
              <RunsList :runs="runs" :env-id="envId" :season-id="view.season.id" />
            </section>
          </template>
        </main>
      </div>

      <DevelopmentCallHistoryDialog
        v-model:open="historyOpen"
        :title="historyUserId === null ? 'Development call history' : `${historyUserId} call history`"
        :calls="historyCalls"
        :next-cursor="historyNextCursor"
        :loading="historyLoading"
        :loading-more="historyLoadingMore"
        :error="historyError ?? undefined"
        @load-more="loadMoreDevelopmentHistory"
        @closed="closeDevelopmentHistory"
      />

      <UiDialog
        v-if="view !== null"
        v-model:open="deleteOpen"
        title="Delete season?"
        :description="`Permanently delete ${seasonLabel(view.season)}?`"
      >
        <p class="delete-confirmation">
          Only closed, unreleased seasons without activity can be permanently deleted.
        </p>
        <p v-if="deleteError" class="delete-error" role="alert">{{ deleteError }}</p>
        <UiDialogActions>
          <UiButton variant="danger" :loading="deleting" @click="confirmDelete">
            Delete season
          </UiButton>
          <UiButton variant="ghost" :disabled="deleting" @click="closeDelete">Cancel</UiButton>
        </UiDialogActions>
      </UiDialog>
    </template>
  </section>
</template>

<style scoped>
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

.development-table-wrap {
  overflow-x: auto;
}

.development-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.development-table th,
.development-table td {
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
  text-align: left;
}

.development-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.development-table .num {
  text-align: right;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.participant-history-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-accent);
  font: inherit;
  cursor: pointer;
}

.development-user-row {
  cursor: pointer;
}

.development-user-row:hover {
  background: var(--color-surface-raised);
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

.section-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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

.delete-confirmation {
  margin: 0;
  color: var(--color-text-muted);
}

.delete-error {
  margin: 0 0 var(--space-3);
  color: var(--color-danger);
  font-size: var(--text-sm);
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
