<!--
  The submitted-agent watch/rate picker (Stage 5.6, extended in Stage 7.6): lists the play-open
  season's active `ready` agents and lets an allowlisted viewer stream them into the renderer. The hub
  fetches the list once and passes it in; this component is otherwise self-contained for starting a
  run. Regular users receive numbered anonymous rows plus their own rating state; operators
  additionally receive owner/source details.

  Clicking any row — built-in Naive or a submitted agent — opens the same watch configuration dialog
  for a multi-seat environment, preselecting that agent into every seat (SeatAssignmentDialog), where
  the viewer assigns an agent to each seat and a seed before starting. A single-slot environment keeps
  the Stage 5 shape: the row starts a scripted watch run immediately, now expressed as a one-seat
  `slots` assignment. The post-session panel takes the rating after the run. Non-allowlisted viewers
  can browse the list but cannot start a container.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import {
  type SlotAssignmentInput,
  type StartPayload,
  startSession,
  type WatchAgentSummary,
} from '../api/client.js'
import { useMe } from '../me.js'
import SeatAssignmentDialog from './SeatAssignmentDialog.vue'
import UiBadge from './ui/UiBadge.vue'
import UiButton from './ui/UiButton.vue'
import UiDialog from './ui/UiDialog.vue'
import UiEmptyState from './ui/UiEmptyState.vue'

const props = defineProps<{
  envId: string
  meta: EnvironmentMeta
  /** The play-open season's active `ready` agents, fetched once by the hub; null while it loads. */
  agents: WatchAgentSummary[] | null
}>()

const router = useRouter()
const me = useMe()

// The built-in Naive agent has no submission id, so a sentinel keys its loading state distinctly
// from any real submission id.
const BUILTIN_KEY = '__builtin__'

const startError = ref<string | null>(null)
// The submission a watch run is being started for, so only its button shows the loading state. Only
// the single-seat immediate-start path uses it; the multi-seat path starts from the dialog instead.
const starting = ref<string | null>(null)

// The watch configuration dialog's state (multi-seat environments only). It opens with the clicked
// agent preselected into every seat, which the viewer can change before starting.
const multiSeat = computed(() => props.meta.max_slots > 1)
const dialogOpen = ref(false)
const dialogPreselect = ref<SlotAssignmentInput | null>(null)

/** A short, human-friendly label for a submission's pinned source. */
function sourceLabel(agent: WatchAgentSummary): string {
  if (agent.commit_sha != null) {
    return agent.commit_sha.slice(0, 10)
  }
  return agent.source_kind === 'local' ? 'local folder' : 'git'
}

function agentLabel(agent: WatchAgentSummary): string {
  if (agent.rating_status === 'own') {
    return 'Your agent'
  }
  return `Submitted agent ${agent.anonymous_number}`
}

function actionLabel(agent: WatchAgentSummary): string {
  return agent.rating_status === 'unrated' ? 'Rate' : 'Watch again'
}

/** Watch a submitted agent: open the seat dialog (multi-seat) or start a one-seat run immediately. */
function watch(agent: WatchAgentSummary): void {
  chooseAgent({ kind: 'submission', submissionId: agent.submission_id }, agent.submission_id)
}

/** Watch the built-in Naive agent: a scripted run with no submission. */
function watchBuiltin(): void {
  chooseAgent({ kind: 'builtin-agent' }, BUILTIN_KEY)
}

/**
 * A clicked agent row resolves to a seat assignment. A multi-seat environment opens the watch dialog
 * with that agent preselected into every seat; a single-slot environment skips the dialog and starts
 * the scripted run right away, as the Stage 5 watch flow did.
 */
function chooseAgent(preselect: SlotAssignmentInput, loadingKey: string): void {
  if (multiSeat.value) {
    dialogPreselect.value = preselect
    startError.value = null
    dialogOpen.value = true
    return
  }
  void startRun({ slots: { player_0: preselect } }, loadingKey)
}

/**
 * Start a watch run from a composed payload — the seat dialog's full `slots` (with its seed) for a
 * multi-seat environment, or a one-seat assignment for a single-slot one — and navigate to it,
 * reusing the rejoin / not-allowlisted / error handling.
 */
async function startRun(payload: StartPayload, loadingKey?: string): Promise<void> {
  startError.value = null
  if (loadingKey !== undefined) {
    starting.value = loadingKey
  }
  try {
    const result = await startSession({ envId: props.envId, ...payload })
    if (result.ok) {
      await router.push(`/sessions/${result.session.id}`)
    } else if (result.reason === 'already_active') {
      // Rejoin rather than dead-end: the viewer already has a session running.
      await router.push(`/sessions/${result.activeSessionId}`)
    } else if (result.reason === 'not_allowlisted') {
      startError.value = 'You are not on the session allowlist.'
      dialogOpen.value = false
    } else {
      startError.value = result.message
      dialogOpen.value = false
    }
  } finally {
    starting.value = null
  }
}
</script>

<template>
  <UiEmptyState v-if="agents === null">Loading agents…</UiEmptyState>
  <template v-else>
    <ul class="agent-list">
      <!-- The environment's built-in Naive agent, pinned at the top and watchable like a
           submitted agent (a scripted run with no submission). It has no owner profile. -->
      <li class="agent-row agent-row--builtin">
        <div class="agent-id">
          <span class="agent-name">Naive agent</span>
          <UiBadge>Built-in</UiBadge>
        </div>
        <UiButton
          v-if="me.me?.allowlisted"
          size="tight"
          variant="secondary"
          :loading="starting === BUILTIN_KEY"
          @click="watchBuiltin()"
        >
          Watch
        </UiButton>
      </li>
      <li v-for="agent in agents" :key="agent.submission_id" class="agent-row">
        <div class="agent-id">
          <template v-if="agent.owner_id !== undefined">
            <RouterLink class="agent-owner" :to="`/environments/${envId}/agents/${agent.owner_id}`">
              {{ agent.owner_id }}
            </RouterLink>
            <code class="agent-source">{{ sourceLabel(agent) }}</code>
          </template>
          <span v-else class="agent-name">{{ agentLabel(agent) }}</span>
          <UiBadge v-if="agent.rating_status === 'unrated'" variant="accent">Not rated</UiBadge>
          <UiBadge v-else-if="agent.rating_status === 'rated'">Rated</UiBadge>
        </div>
        <UiButton
          v-if="me.me?.allowlisted"
          size="tight"
          :variant="agent.rating_status === 'unrated' ? 'primary' : 'secondary'"
          :loading="starting === agent.submission_id"
          @click="watch(agent)"
        >
          {{ actionLabel(agent) }}
        </UiButton>
      </li>
    </ul>
    <p v-if="agents.length === 0" class="agent-subnote">No submitted agents are ready to watch yet.</p>
    <UiEmptyState v-if="!me.me?.allowlisted">
      Watching an agent is limited to allowlisted users.
    </UiEmptyState>
    <p v-if="startError !== null" class="agent-error" role="alert">{{ startError }}</p>

    <!-- The watch configuration dialog for a multi-seat environment: assign an agent to every seat,
         the clicked agent preselected, then start the scripted run from the composed `slots`. -->
    <UiDialog v-model:open="dialogOpen" :title="`Watch ${meta.display_name}`">
      <SeatAssignmentDialog
        v-if="dialogOpen && dialogPreselect !== null"
        :meta="meta"
        :agents="agents ?? []"
        mode="watch"
        :preselect="dialogPreselect"
        :is-operator="me.me?.is_operator"
        @start="startRun"
        @cancel="dialogOpen = false"
      />
    </UiDialog>
  </template>
</template>

<style scoped>
.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.agent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-border);
}

.agent-id {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.agent-name {
  color: var(--color-text);
}

.agent-subnote {
  margin: var(--space-2) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.agent-owner {
  color: var(--color-text);
  transition: color var(--motion-fast) var(--ease-out);
}

.agent-owner:hover {
  color: var(--color-accent);
}

.agent-source {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.agent-error {
  margin: var(--space-2) 0 0;
  color: var(--color-danger);
  font-size: var(--text-sm);
}
</style>
