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
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronDown, ChevronRight, Clock, FolderOpen, GitCommit, Play, Trophy } from '@lucide/vue'

import {
  type AgentPlacements,
  type AgentPlacementView,
  type AgentProfile,
  type AgentProfileSubmission,
  getAgentPlacements,
  getAgentProfile,
  type SubmissionStatus,
} from '../api/client.js'
import AuthorPromptEditor from '../components/AuthorPromptEditor.vue'
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
import { useMe } from '../me.js'

const route = useRoute()
const me = useMe()
const envId = String(route.params.envId)
const ownerId = String(route.params.ownerId)

const profile = ref<AgentProfile | null>(null)
const failed = ref(false)
// The agent's released leaderboard placements (Stage 6.7), read from the public placements route. A
// failed read leaves the list empty rather than failing the whole profile.
const placements = ref<AgentPlacements | null>(null)

onMounted(() => {
  getAgentProfile(envId, ownerId).then(
    (data) => {
      profile.value = data
    },
    () => {
      failed.value = true
    },
  )
  getAgentPlacements(envId, ownerId).then(
    (data) => {
      placements.value = data
    },
    () => {
      placements.value = { env_id: envId, owner_id: ownerId, placements: [] }
    },
  )
})

const STATUS_LABEL: Record<SubmissionStatus, string> = {
  pending: 'pending',
  // "ready" on its own reads as ambiguous ("ready for what?"); spell out that it passed validation
  // and is eligible to play, the thing the all-green stepper is showing.
  ready: 'ready to compete',
  static_failed: 'static check failed',
  build_failed: 'build failed',
  load_failed: 'load check failed',
}
const STATUS_TONE: Record<SubmissionStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending: 'warning',
  ready: 'success',
  static_failed: 'danger',
  build_failed: 'danger',
  load_failed: 'danger',
}

/** The left-edge accent stripe that lets a stack of submissions be scanned by outcome. */
const statusAccentClass = (status: SubmissionStatus): string => `status-${STATUS_TONE[status]}`

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
const isOwner = () => me.me?.user_id === ownerId

/** "My Submissions" on your own profile, "{owner}'s Submissions" when viewing someone else's. */
const heading = computed(() => (isOwner() ? 'My Submissions' : `${ownerId}'s Submissions`))

/**
 * The active submission whose season the author-prompt editor targets. Public play takes
 * precedence because that is the agent raters can currently encounter. When no round is play-open,
 * fall back to the submission-open round so an author can prepare its prompt before play begins.
 */
const promptSubmission = computed(() => {
  const data = profile.value
  if (data === null) {
    return null
  }
  for (const seasonId of [
    data.play_season_id,
    data.submission_season_id,
  ]) {
    if (seasonId === null) {
      continue
    }
    const submission = data.submissions.find(
      (candidate) =>
        candidate.season_id === seasonId && candidate.superseded_at === null,
    )
    if (submission !== undefined) {
      return submission
    }
  }
  return null
})

/** A placement's season name, falling back to a short id when the season has no label. */
const seasonLabel = (label: string | null, id: string): string =>
  label ?? `Season ${id.slice(0, 8)}`
</script>

<template>
  <UiEmptyState v-if="failed" tone="danger">Could not load this agent profile.</UiEmptyState>
  <UiEmptyState v-else-if="profile === null">Loading…</UiEmptyState>
  <section v-else class="agent">
    <header>
      <h1>{{ heading }}</h1>
    </header>

    <section v-if="isOwner()" class="agent-section">
      <h2>Submit an Agent</h2>
      <SubmitAgentForm v-if="profile.submission_season_id !== null" :env-id="envId" />
      <UiEmptyState v-else>Submissions are closed for this environment right now.</UiEmptyState>
    </section>

    <section class="agent-section">
      <h2>Submission History</h2>
      <UiEmptyState v-if="profile.submissions.length === 0">
        {{ ownerId }} has not submitted an agent for this environment yet.
      </UiEmptyState>
      <div v-else class="season-groups">
        <div v-for="group in seasonGroups" :key="group.seasonId" class="season-group">
          <p v-if="seasonGroups.length > 1" class="season-caption">{{ seasonCaption(group.seasonId) }}</p>
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
                    <code class="submission-id">#{{ shortId(submission.id) }}</code>
                    <UiStatusBadge
                      :tone="STATUS_TONE[submission.status]"
                      :label="STATUS_LABEL[submission.status]"
                    />
                    <UiBadge v-if="submission.superseded_at === null" variant="accent">Current</UiBadge>
                    <span v-else class="lifecycle-tag">Superseded</span>
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

                    <template v-if="placement !== null">
                      <hr class="submission-divider" />
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

    <AuthorPromptEditor
      v-if="isOwner() && promptSubmission !== null"
      :season-id="promptSubmission.season_id"
    />

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
  margin-top: var(--space-6);
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
}

.season-caption {
  margin: 0;
  font-size: var(--text-xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
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

.submission-id {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.lifecycle-tag {
  font-size: var(--text-xs);
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
