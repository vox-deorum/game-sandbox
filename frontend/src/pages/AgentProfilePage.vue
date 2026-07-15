<!--
  The agent profile page (Stage 5.6): one page per submitted agent, keyed by environment id and owner
  id (the one-active-submission-per-user-per-season boundary, which keeps a future Hearts agent
  separate from the same user's Flappy Bird agent). It shows, from the single profile read:

  - Submission history across seasons, including superseded rows, so the owner sees every commit
    they submitted, not just the active one.
  - Build / validation status: each submission's rollup plus its per-stage validation log, rendered
    with the shared stage timeline. A load_failed submission shows the failed stage and its captured
    error here instead of a session, making the exit-criterion case visible to the owner.
  - Recent replays: the recordings the agent's submissions ran in, each linking to its replay page.
  - Inert placeholders for leaderboard placements (Stage 6) and the owner's LLM debug view (Stage 9),
    matching the Stage 4.5 convention of showing where later stages plug in. The debug placeholder is
    owner-only, gating on the signed-in identity matching the agent's owner.
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronDown, ChevronRight, Clock, FolderOpen, GitCommit, Play, Trophy } from '@lucide/vue'

import {
  type AgentPlacements,
  type AgentPlacementView,
  type AgentProfile,
  type AgentProfileSubmission,
  getAgentPlacements,
  getAgentProfile,
  listSeasons,
  type PublicSeasonView,
  type SubmissionStatus,
} from '../api/client.js'
import SubmissionStageTimeline from '../components/SubmissionStageTimeline.vue'
import SubmitAgentForm from '../components/SubmitAgentForm.vue'
import UiBadge from '../components/ui/UiBadge.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import {
  formatComputeMs,
  formatDate,
  formatRating,
  formatReplayLabel,
  formatScore,
  shortId,
} from '../lib/format.js'
import {
  type SubmissionStatusTone,
  submissionStatusLabel,
  submissionStatusTone,
} from '../lib/submission-status.js'
import { canParticipate, useMe, userId } from '../me.js'

const route = useRoute()
const me = useMe()
const envId = String(route.params.envId)
const ownerId = String(route.params.ownerId)

const profile = ref<AgentProfile | null>(null)
const failed = ref(false)
// The agent's released leaderboard placements (Stage 6.7), read from the public placements route. A
// failed read leaves the list empty rather than failing the whole profile.
const placements = ref<AgentPlacements | null>(null)

// A form acceptance refresh can overlap the later terminal refresh. Only the newest request may
// replace the page state, so a slower pending response cannot overwrite the terminal submission.
let profileLoadSerial = 0
async function refreshProfile(): Promise<void> {
  const serial = ++profileLoadSerial
  try {
    const data = await getAgentProfile(envId, ownerId)
    if (serial === profileLoadSerial) {
      profile.value = data
      failed.value = false
    }
  } catch {
    if (serial === profileLoadSerial && profile.value === null) {
      failed.value = true
    }
  }
}

onMounted(() => {
  void refreshProfile()
  getAgentPlacements(envId, ownerId).then(
    (data) => {
      placements.value = data
    },
    () => {
      placements.value = { env_id: envId, owner_id: ownerId, placements: [] }
    },
  )
})

/** The left-edge accent stripe that lets a stack of submissions be scanned by outcome. */
const statusAccentClass = (status: SubmissionStatus): string => `status-${submissionStatusTone(status)}`

/**
 * The single lifecycle-aware badge for a submission's summary row, folding the old standalone
 * "Current" badge into the status label: a current ready submission reads "ready to compete", while a
 * ready submission that has since been superseded reads "superseded" (it was eligible to play, but a
 * newer submission has replaced it). Every other status keeps its shared label and tone.
 */
const statusBadge = (
  submission: AgentProfileSubmission,
): { label: string; tone: SubmissionStatusTone } => {
  if (submission.status === 'ready' && submission.superseded_at !== null) {
    return { label: 'superseded', tone: 'neutral' }
  }
  return { label: submissionStatusLabel(submission.status), tone: submissionStatusTone(submission.status) }
}

/**
 * The owner's submissions grouped by season (the one-active-per-user-per-season boundary): each group
 * is its season's submissions newest-first plus the id of the active (non-superseded) one, which the
 * history opens by default. Each row also carries its leaderboard placement, matched by the
 * `agent_submission_id` the placements route already returns, so a submission and its result link both
 * ways without a second request. Groups are ordered by their active submission's date, newest first.
 */
interface SeasonGroup {
  seasonId: string
  activeId: string
  rows: { submission: AgentProfileSubmission; placement: AgentPlacementView | null }[]
}

const placementBySubmissionId = computed(() => {
  const map = new Map<string, AgentPlacementView>()
  for (const placement of placements.value?.placements ?? []) {
    if (placement.agent_submission_id !== null) {
      map.set(placement.agent_submission_id, placement)
    }
  }
  return map
})

const seasonGroups = computed<SeasonGroup[]>(() => {
  const data = profile.value
  if (data === null) {
    return []
  }
  const placementMap = placementBySubmissionId.value
  const bySeason = new Map<string, AgentProfileSubmission[]>()
  for (const submission of data.submissions) {
    const list = bySeason.get(submission.season_id) ?? []
    list.push(submission)
    bySeason.set(submission.season_id, list)
  }
  const groups: SeasonGroup[] = []
  for (const [seasonId, submissions] of bySeason) {
    const sorted = [...submissions].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    )
    const active = sorted.find((s) => s.superseded_at === null) ?? sorted[0]
    if (active === undefined) {
      continue
    }
    groups.push({
      seasonId,
      activeId: active.id,
      rows: sorted.map((submission) => ({
        submission,
        placement: placementMap.get(submission.id) ?? null,
      })),
    })
  }
  const activeDate = (group: SeasonGroup): number => {
    const active = group.rows.find((row) => row.submission.id === group.activeId)
    return active === undefined ? 0 : Date.parse(active.submission.created_at)
  }
  return groups.sort((a, b) => activeDate(b) - activeDate(a))
})

/**
 * Which submission is expanded in each season, keyed by season id. The single-open-per-season rule:
 * opening a row collapses whichever was open in that season. Defaults to the active submission; an
 * empty string means the owner explicitly collapsed the whole group.
 */
const openBySeason = ref<Record<string, string>>({})
watch(
  seasonGroups,
  (groups) => {
    const next: Record<string, string> = {}
    for (const group of groups) {
      const existing = openBySeason.value[group.seasonId]
      const known =
        existing === '' || group.rows.some((row) => row.submission.id === existing)
      next[group.seasonId] = existing !== undefined && known ? existing : group.activeId
    }
    openBySeason.value = next
  },
  { immediate: true },
)

const isOpen = (seasonId: string, submissionId: string): boolean =>
  openBySeason.value[seasonId] === submissionId

function toggle(seasonId: string, submissionId: string): void {
  openBySeason.value = {
    ...openBySeason.value,
    [seasonId]: openBySeason.value[seasonId] === submissionId ? '' : submissionId,
  }
}

/** A season's display label for the group caption, borrowed from any placement in that season. */
const seasonCaption = (seasonId: string): string => {
  const placement = placements.value?.placements.find((p) => p.season_id === seasonId)
  return placement?.season_label ?? `Season ${shortId(seasonId)}`
}

/** The owner viewing their own profile unlocks the owner-only affordances (the Stage 9 debug view). */
const isOwner = () => userId(me.me) === ownerId

/** The exact active attempt in the submission-open season, never an active row from another season. */
const currentSeasonSubmission = computed(() => {
  const seasonId = profile.value?.submission_season_id
  if (seasonId === null || seasonId === undefined) {
    return null
  }
  return (
    profile.value?.submissions.find(
      (submission) => submission.season_id === seasonId && submission.superseded_at === null,
    ) ?? null
  )
})

// Public season metadata improves the banner label, but it is owner-only and non-blocking. The short
// id fallback renders immediately and remains if this secondary read fails.
const currentSeasonMetadata = ref<PublicSeasonView | null>(null)
let seasonMetadataSerial = 0
watch(
  [() => profile.value?.submission_season_id, () => userId(me.me)],
  async ([seasonId, viewerId]) => {
    const serial = ++seasonMetadataSerial
    currentSeasonMetadata.value = null
    if (seasonId === null || seasonId === undefined || viewerId !== ownerId) {
      return
    }
    try {
      const seasons = await listSeasons(envId)
      if (serial === seasonMetadataSerial) {
        currentSeasonMetadata.value = seasons.find((season) => season.id === seasonId) ?? null
      }
    } catch {
      // Metadata is presentation-only. The banner keeps its stable short-id fallback.
    }
  },
  { immediate: true },
)

const currentSeasonName = computed(() => {
  const seasonId = profile.value?.submission_season_id
  if (seasonId === null || seasonId === undefined) {
    return null
  }
  return currentSeasonMetadata.value?.label ?? `Season ${shortId(seasonId)}`
})

// My Agents links to a season, not a specific attempt. A query change starts one navigation handling
// pass; asynchronous identity/profile data may complete that pass, but later profile refreshes must not
// repeat its focus and scroll side effects. The current season always targets the compact owner banner.
const seasonGroupKey = computed(() => seasonGroups.value.map((group) => group.seasonId).join('|'))
const seasonQueryNavigation = ref(0)
let handledSeasonQueryNavigation = -1
watch(
  () => route.query.season,
  () => {
    seasonQueryNavigation.value += 1
  },
  { immediate: true },
)
watch(
  [
    seasonQueryNavigation,
    seasonGroupKey,
    () => profile.value?.submission_season_id,
    () => isOwner(),
    () => me.loading,
  ],
  async ([navigation]) => {
    if (
      typeof navigation !== 'number' ||
      navigation === handledSeasonQueryNavigation ||
      profile.value === null ||
      me.loading
    ) {
      return
    }

    const rawSeason = route.query.season
    const seasonId = Array.isArray(rawSeason) ? rawSeason[0] : rawSeason
    if (typeof seasonId !== 'string' || seasonId === '') {
      handledSeasonQueryNavigation = navigation
      return
    }

    const group = seasonGroups.value.find((candidate) => candidate.seasonId === seasonId)
    let targetId: string | null = null
    if (isOwner() && profile.value.submission_season_id === seasonId) {
      targetId = 'current-season-banner'
    } else if (group !== undefined) {
      openBySeason.value = { ...openBySeason.value, [seasonId]: group.activeId }
      targetId = `season-${seasonId}`
    }
    // A fully loaded but unknown id is a valid no-op for this navigation. Do not let a later form
    // refresh reinterpret it and move focus unexpectedly.
    handledSeasonQueryNavigation = navigation
    if (targetId === null) {
      return
    }

    await nextTick()
    if (navigation !== seasonQueryNavigation.value) {
      return
    }
    const target = document.getElementById(targetId)
    target?.focus()
    target?.scrollIntoView?.({ block: 'start' })
  },
  { immediate: true, flush: 'post' },
)

/**
 * "My Submissions" on your own profile, "{owner}'s Submissions" when viewing someone else's. Prefers
 * the profile's resolved display name once it loads; the route-param id is the pre-load fallback (and
 * remains the value shown in the heading's tooltip).
 */
const heading = computed(() => {
  if (isOwner()) {
    return 'My Submissions'
  }
  const name = profile.value?.owner_name ?? ownerId
  return `${name}'s Submissions`
})

/** The owner's rating prompt for a season, or null when they set none (shown per season group). */
const authorPromptFor = (seasonId: string): string | null =>
  profile.value?.author_prompts[seasonId] ?? null

/** A placement's season name, falling back to a short id when the season has no label. */
const seasonLabel = (label: string | null, id: string): string =>
  label ?? `Season ${id.slice(0, 8)}`
</script>

<template>
  <UiEmptyState v-if="failed" tone="danger">Could not load this agent profile.</UiEmptyState>
  <UiEmptyState v-else-if="profile === null">Loading…</UiEmptyState>
  <section v-else class="agent">
    <header>
      <h1 :title="ownerId">{{ heading }}</h1>
    </header>

    <section v-if="isOwner()" class="agent-section">
      <!-- The current-season context rides on the heading as two tags — a season pill and a
           submission-status badge — rather than a standalone card. Keeps the id/tabindex anchor the
           season deep-link navigation focuses and scrolls to. -->
      <div id="current-season-banner" class="submit-head" tabindex="-1">
        <h2>Submit an Agent</h2>
        <template v-if="profile.submission_season_id !== null">
          <UiBadge>Current Season: {{ currentSeasonName }}</UiBadge>
          <UiStatusBadge
            v-if="currentSeasonSubmission !== null"
            v-bind="statusBadge(currentSeasonSubmission)"
          />
          <UiStatusBadge v-else label="Not submitted" tone="warning" />
        </template>
        <span v-else class="submit-none">No Season is accepting submissions right now.</span>
      </div>
      <!-- Submitting is a participation action (requireActive on the backend), so a pending owner
           sees why it is off rather than an enabled control that 403s. -->
      <template v-if="profile.submission_season_id !== null && canParticipate(me.me)">
        <SubmitAgentForm
          :env-id="envId"
          :submission-season-id="profile.submission_season_id"
          @accepted="refreshProfile"
          @settled="refreshProfile"
        />
      </template>
      <UiEmptyState v-else-if="profile.submission_season_id !== null">
        Your account is awaiting approval, so you can't submit yet.
      </UiEmptyState>
    </section>

    <section class="agent-section">
      <h2>Submission History</h2>
      <UiEmptyState v-if="profile.submissions.length === 0">
        <span :title="ownerId">{{ profile.owner_name ?? ownerId }}</span> has not submitted an agent
        for this environment yet.
      </UiEmptyState>
      <div v-else class="season-groups">
        <div
          v-for="group in seasonGroups"
          :id="`season-${group.seasonId}`"
          :key="group.seasonId"
          class="season-group"
          tabindex="-1"
        >
          <p v-if="seasonGroups.length > 1" class="season-caption">{{ seasonCaption(group.seasonId) }}</p>
          <p v-if="authorPromptFor(group.seasonId)" class="season-prompt">
            Rating prompt: “{{ authorPromptFor(group.seasonId) }}”
          </p>
          <ol class="submission-list">
            <li
              v-for="{ submission, placement } in group.rows"
              :id="`submission-${submission.id}`"
              :key="submission.id"
              class="submission-item"
            >
              <UiCard :padded="false">
                <div class="submission-body" :class="statusAccentClass(submission.status)">
                  <button
                    type="button"
                    class="submission-summary"
                    :aria-expanded="isOpen(group.seasonId, submission.id)"
                    :aria-controls="`submission-detail-${submission.id}`"
                    @click="toggle(group.seasonId, submission.id)"
                  >
                    <component
                      :is="isOpen(group.seasonId, submission.id) ? ChevronDown : ChevronRight"
                      :size="16"
                      class="summary-caret"
                      aria-hidden="true"
                    />
                    <span class="submission-season">{{ seasonCaption(group.seasonId) }}</span>
                    <code class="submission-id">#{{ shortId(submission.id) }}</code>
                    <UiStatusBadge v-bind="statusBadge(submission)" />
                    <span class="submission-date">
                      <Clock :size="13" aria-hidden="true" />{{ formatDate(submission.created_at) }}
                    </span>
                  </button>

                  <div
                    v-if="isOpen(group.seasonId, submission.id)"
                    :id="`submission-detail-${submission.id}`"
                    class="submission-detail"
                  >
                    <p class="submission-source">
                      <template v-if="submission.repo_url !== null">
                        <GitCommit :size="14" class="source-icon" aria-hidden="true" />
                        <span class="submission-repo">{{ submission.repo_url }}</span>
                        <code v-if="submission.commit_sha !== null">{{ submission.commit_sha.slice(0, 10) }}</code>
                      </template>
                      <template v-else>
                        <FolderOpen :size="14" class="source-icon" aria-hidden="true" />
                        Local folder submission.
                      </template>
                    </p>

                    <hr class="submission-divider" />

                    <SubmissionStageTimeline :checks="submission.checks" :show-detail="true" />

                    <hr class="submission-divider" />
                    <template v-if="placement !== null">
                      <RouterLink
                        class="submission-result"
                        :to="`/environments/${envId}/leaderboards/${placement.season_id}`"
                      >
                        <Trophy :size="15" class="result-icon" aria-hidden="true" />
                        <span class="result-text">
                          Rank {{ placement.rank }} in
                          {{ seasonLabel(placement.season_label, placement.season_id) }} · Avg Score
                          {{ formatScore(placement.mean_score) }} <template
                            v-if="placement.human_mean !== null"
                          >
                            · Avg ★ {{ formatRating(placement.human_mean) }}</template
                          >
                        </span>
                        <span class="result-link">View leaderboard →</span>
                      </RouterLink>
                    </template>
                    <p v-else-if="submission.status === 'ready'" class="submission-result-empty">
                      Not yet on a released leaderboard.
                    </p>

                    <hr class="submission-divider" />

                    <div class="submission-replays">
                      <h3 class="submission-replays-title">Recent replays</h3>
                      <UiEmptyState v-if="submission.replays.length === 0">No replays yet.</UiEmptyState>
                      <ul v-else class="replay-list">
                        <li v-for="replay in submission.replays" :key="replay">
                          <RouterLink
                            class="replay-chip"
                            :to="`/replays/${replay}`"
                            :aria-label="replay"
                            :title="replay"
                          >
                            <Play :size="13" aria-hidden="true" />
                            <span>{{ formatReplayLabel(replay) }}</span>
                          </RouterLink>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
              </UiCard>
            </li>
          </ol>
        </div>
      </div>
    </section>

    <section class="agent-section">
      <h2>Leaderboard Placements</h2>
      <UiEmptyState v-if="placements === null">Loading…</UiEmptyState>
      <UiEmptyState v-else-if="placements.placements.length === 0">
        No released placements for this agent yet.
      </UiEmptyState>
      <table v-else class="placements-table">
        <colgroup>
          <col class="col-rank" />
          <col span="6" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" class="rank">Rank</th>
            <th scope="col" class="num">Human rating</th>
            <th scope="col" class="num">Mean score</th>
            <th scope="col" class="num">Agent compute</th>
            <th scope="col">Season</th>
            <th scope="col">Submission</th>
            <th scope="col">Replay</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="placement in placements.placements" :key="placement.id">
            <td class="rank">{{ placement.rank }}</td>
            <td class="num">
              <span v-if="placement.human_mean !== null">{{ formatRating(placement.human_mean) }}</span>
              <span v-else class="muted" title="No ratings yet">—</span>
            </td>
            <td class="num">{{ formatScore(placement.mean_score) }}</td>
            <td class="num">{{ formatComputeMs(placement.mean_agent_compute_ms) }}</td>
            <td>
              <RouterLink
                class="placement-link"
                :to="`/environments/${envId}/leaderboards/${placement.season_id}`"
              >
                {{ seasonLabel(placement.season_label, placement.season_id) }}
              </RouterLink>
            </td>
            <td>
              <a
                v-if="placement.agent_submission_id !== null"
                class="submission-anchor"
                :href="`#submission-${placement.agent_submission_id}`"
                :title="`Jump to submission ${shortId(placement.agent_submission_id)}`"
              >
                #{{ shortId(placement.agent_submission_id) }}
              </a>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <RouterLink
                v-if="placement.recording_id !== null"
                class="replay-link"
                :to="`/replays/${placement.recording_id}`"
              >
                Replay
              </RouterLink>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <p v-if="isOwner()" class="agent-placeholder">
      Your agent's LLM debug view arrives in a later stage.
    </p>
  </section>
</template>

<style scoped>
.agent-section {
  margin-bottom: var(--space-6);
}

/* The Submit an Agent heading and its current-season tags share one wrapping row. The id/tabindex
   anchor lives here so the season deep-link navigation can focus and scroll to it. */
.submit-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
  scroll-margin-top: var(--space-5);
}

.submit-head h2 {
  margin: 0;
}

.submit-none {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.season-groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.season-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  scroll-margin-top: var(--space-5);
}

.season-caption {
  margin: 0;
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

/* The owner's rating prompt for the season, shown once per season group above its submissions. */
.season-prompt {
  margin: 0;
  font-size: var(--text-sm);
  font-style: italic;
  color: var(--color-text-muted);
}

.submission-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* So an anchor jump from the placements table's Submission column lands below the sticky header. */
.submission-item {
  scroll-margin-top: var(--space-5);
}

/* The status accent stripe lets a stack of submissions be scanned by outcome. The body owns its
   padding (the card is unpadded) so the stripe runs flush to the card edge. */
.submission-body {
  padding: var(--space-4) var(--space-5);
  border-left: 3px solid transparent;
}

.submission-body.status-success {
  border-left-color: var(--color-success);
}

.submission-body.status-danger {
  border-left-color: var(--color-danger);
}

.submission-body.status-warning {
  border-left-color: var(--color-warning);
}

.submission-body.status-neutral {
  border-left-color: var(--color-border-strong);
}

.submission-summary {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.summary-caret {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.submission-season {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-text);
}

.submission-id {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.submission-date {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.submission-detail {
  margin-top: var(--space-3);
}

.submission-divider {
  margin: var(--space-3) 0;
  border: none;
  border-top: 1px solid var(--color-border);
}

.submission-source {
  margin: 0;
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
  font-size: var(--text-sm);
}

.source-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.submission-repo {
  color: var(--color-text);
  word-break: break-all;
}

.submission-result {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text);
}

.result-icon {
  flex-shrink: 0;
  color: var(--color-warning);
}

.result-link {
  margin-left: auto;
  color: var(--color-accent);
  white-space: nowrap;
}

.submission-result:hover .result-link {
  text-decoration: underline;
}

.submission-result-empty {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.submission-replays-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.replay-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.replay-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: var(--color-surface-raised);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.replay-chip:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.placements-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.placements-table th,
.placements-table td {
  text-align: left;
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.placements-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

/* The rank column matches the environment leaderboard: a narrow, left-aligned leading column. */
.placements-table .col-rank {
  width: 3rem;
}

.placements-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.placements-table .muted {
  color: var(--color-text-muted);
}

.placement-link,
.replay-link {
  color: var(--color-accent);
}

.submission-anchor {
  font-family: var(--font-mono);
  color: var(--color-accent);
}

.agent-placeholder {
  margin-top: var(--space-6);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
</style>
