<!--
  My Agents: the student's cross-game index of their own submissions — the feedback loop they return
  to most ("how is my agent doing?"), lifted out of any single game. Each game where the signed-in
  user has submitted shows its active submission's status and links to the full agent profile.

  Phase 1 aggregates the per-game agent-profile read across every environment for the signed-in user.
  A later pass swaps in a single backing endpoint; the page shape stays the same.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { type AgentProfile, getAgentProfile, getEnvironments } from '../api/client.js'
import UiBadge from '../components/ui/UiBadge.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import { currentUserId } from '../identity.js'
import { formatDate } from '../lib/format.js'
import { submissionStatusLabel, submissionStatusTone } from '../lib/submission-status.js'
import { useMe } from '../me.js'

interface EnvironmentAgent {
  meta: EnvironmentMeta
  profile: AgentProfile
}

const me = useMe()
const ownerId = ref(currentUserId)
const rows = ref<EnvironmentAgent[] | null>(null)
const error = ref(false)


onMounted(async () => {
  await me.whenSettled()
  ownerId.value = me.me?.user_id ?? currentUserId
  try {
    const envs = await getEnvironments()
    const profiles = await Promise.all(
      envs.map(async (meta) => ({
        meta,
        profile: await getAgentProfile(meta.env_id, ownerId.value).catch(() => null),
      })),
    )
    rows.value = profiles.filter(
      (entry): entry is EnvironmentAgent => entry.profile !== null && entry.profile.submissions.length > 0,
    )
  } catch {
    error.value = true
  }
})

/** The active (non-superseded) submission for a game, or the most recent one as a fallback. */
function activeSubmission(profile: AgentProfile) {
  return profile.submissions.find((s) => s.superseded_at === null) ?? profile.submissions[0]
}
</script>

<template>
  <section class="my-agents">
    <header class="my-agents-intro">
      <h1>My Agents</h1>
      <p class="my-agents-lede">Every environment you have an agent in, and how it is doing.</p>
    </header>

    <UiEmptyState v-if="error" tone="danger">Could not load your agents.</UiEmptyState>
    <UiEmptyState v-else-if="rows === null">Loading…</UiEmptyState>
    <UiEmptyState v-else-if="rows.length === 0">
      You have not submitted an agent yet. Pick a <a href="/">game environment</a> to get started.
    </UiEmptyState>
    <ul v-else class="agent-list">
      <li v-for="row in rows" :key="row.meta.env_id">
        <UiCard>
          <div class="agent-head">
            <span class="agent-game">{{ row.meta.display_name }}</span>
            <UiStatusBadge
              v-if="activeSubmission(row.profile)"
              :tone="submissionStatusTone(activeSubmission(row.profile)!.status)"
              :label="submissionStatusLabel(activeSubmission(row.profile)!.status)"
            />
          </div>
          <p class="agent-meta">
            <UiBadge>{{ row.profile.submissions.length }} submission{{ row.profile.submissions.length === 1 ? '' : 's' }}</UiBadge>
            <span v-if="activeSubmission(row.profile)" class="agent-date">
              latest {{ formatDate(activeSubmission(row.profile)!.created_at) }}
            </span>
          </p>
          <RouterLink
            class="agent-link"
            :to="`/environments/${row.meta.env_id}/agents/${ownerId}`"
          >
            Open agent profile →
          </RouterLink>
        </UiCard>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.my-agents-intro {
  margin-bottom: var(--space-5);
}

.my-agents-intro h1 {
  margin: 0 0 var(--space-1);
}

.my-agents-lede {
  margin: 0;
  color: var(--color-text-muted);
}

.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.agent-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.agent-game {
  font-size: var(--text-lg);
  font-weight: 600;
}

.agent-meta {
  margin: 0 0 var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  font-size: var(--text-sm);
}

.agent-date {
  color: var(--color-text-muted);
}

.agent-link {
  color: var(--color-accent);
  font-size: var(--text-sm);
}
</style>
