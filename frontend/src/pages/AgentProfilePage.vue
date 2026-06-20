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
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  type AgentPlacements,
  type AgentProfile,
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
import { formatComputeMs, formatDate, formatScore } from '../lib/format.js'
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
  ready: 'ready',
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

/** The owner viewing their own profile unlocks the owner-only affordances (the Stage 9 debug view). */
const isOwner = () => me.me?.user_id === ownerId

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
</script>

<template>
  <UiEmptyState v-if="failed" tone="danger">Could not load this agent profile.</UiEmptyState>
  <UiEmptyState v-else-if="profile === null">Loading…</UiEmptyState>
  <section v-else class="agent">
    <header class="agent-header">
      <h1>{{ ownerId }}</h1>
      <p class="agent-sub">Submitted agents for {{ envId }}.</p>
    </header>

    <section v-if="isOwner()" class="agent-section">
      <h2>Submit an agent</h2>
      <SubmitAgentForm v-if="profile.submission_season_id !== null" :env-id="envId" />
      <UiEmptyState v-else>Submissions are closed for this environment right now.</UiEmptyState>
    </section>

    <section class="agent-section">
      <h2>Submission history</h2>
      <UiEmptyState v-if="profile.submissions.length === 0">
        {{ ownerId }} has not submitted an agent for this environment yet.
      </UiEmptyState>
      <ol v-else class="submission-list">
        <li v-for="submission in profile.submissions" :key="submission.id">
          <UiCard>
            <div class="submission-head">
              <UiStatusBadge
                :tone="STATUS_TONE[submission.status]"
                :label="STATUS_LABEL[submission.status]"
              />
              <UiBadge v-if="submission.superseded_at === null" variant="accent">Active</UiBadge>
              <span class="submission-date">{{ formatDate(submission.created_at) }}</span>
            </div>

            <p class="submission-source">
              <template v-if="submission.repo_url !== null">
                <span class="submission-repo">{{ submission.repo_url }}</span>
                <code v-if="submission.commit_sha !== null">{{ submission.commit_sha.slice(0, 10) }}</code>
              </template>
              <template v-else>Local folder submission.</template>
            </p>

            <SubmissionStageTimeline :checks="submission.checks" :show-detail="true" />

            <div class="submission-replays">
              <h3 class="submission-replays-title">Recent replays</h3>
              <UiEmptyState v-if="submission.replays.length === 0">No replays yet.</UiEmptyState>
              <ul v-else class="replay-list">
                <li v-for="replay in submission.replays" :key="replay">
                  <RouterLink class="replay-id" :to="`/replays/${replay}`">{{ replay }}</RouterLink>
                </li>
              </ul>
            </div>
          </UiCard>
        </li>
      </ol>
    </section>

    <AuthorPromptEditor
      v-if="isOwner() && promptSubmission !== null"
      :season-id="promptSubmission.season_id"
    />

    <section class="agent-section">
      <h2>Leaderboard placements</h2>
      <UiEmptyState v-if="placements === null">Loading…</UiEmptyState>
      <UiEmptyState v-else-if="placements.placements.length === 0">
        No released placements for this agent yet.
      </UiEmptyState>
      <table v-else class="placements-table">
        <thead>
          <tr>
            <th scope="col" class="num">Rank</th>
            <th scope="col" class="num">Mean score</th>
            <th scope="col" class="num">Agent compute</th>
            <th scope="col">Season</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="placement in placements.placements" :key="placement.id">
            <td class="num">{{ placement.rank }}</td>
            <td class="num">{{ formatScore(placement.mean_score) }}</td>
            <td class="num">{{ formatComputeMs(placement.mean_agent_compute_ms) }}</td>
            <td>
              <RouterLink
                class="placement-link"
                :to="`/environments/${envId}/leaderboards/${placement.season_id}`"
              >
                View leaderboards
              </RouterLink>
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
.agent-header h1 {
  margin: 0 0 var(--space-2);
}

.agent-sub {
  margin: 0;
  color: var(--color-text-muted);
}

.agent-section {
  margin-top: var(--space-6);
}

.submission-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.submission-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.submission-date {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.submission-source {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}

.submission-repo {
  color: var(--color-text);
  word-break: break-all;
}

.submission-replays {
  margin-top: var(--space-4);
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
}

.replay-id {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text);
  transition: color var(--motion-fast) var(--ease-out);
}

.replay-id:hover {
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

.placements-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.placement-link {
  color: var(--color-accent);
}

.agent-placeholder {
  margin-top: var(--space-6);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
</style>
