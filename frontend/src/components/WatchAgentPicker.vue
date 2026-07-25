<!--
  The submitted-agent watch/rate picker (Stage 5.6, extended in Stage 7.6): lists the play-open
  season's active `ready` agents and lets a participating viewer stream them into the renderer. The hub
  fetches the list once and passes it in; this component is otherwise self-contained for starting a
  run. Regular users receive numbered anonymous rows plus their own rating state; operators
  additionally receive owner/source details.

  Clicking any row, built-in Naive or a submitted agent, opens the same watch configuration dialog for
  a multi-seat environment, preselecting that agent into every seat (SeatAssignmentDialog). A Rate
  action locks the selected agent and every session setting so the resulting feedback applies to the
  intended agent. Watch actions keep the configuration editable. A single-seat environment with no
  visible settings starts a scripted watch run immediately, expressed as a one-seat `seats`
  assignment. The post-session panel takes the rating after the run. An anonymous visitor sees the
  same actions, but clicking one routes to the sign-in page instead of starting a run; a signed-in but
  still-pending account browses without actions and sees the awaiting-approval notice.
-->
<script setup lang="ts">
import {
  type EnvironmentMeta,
  type ParameterValue,
  resolveLayout,
} from '@game-sandbox/schema/environment'
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import {
  type AgentAssignmentInput,
  type StartPayload,
  startSession,
  type WatchAgentSummary,
} from '../api/client.js'
import { maskedSubmissionLabel } from '../lib/attribution.js'
import { handleSessionStartResult } from '../lib/session-start.js'
import { visibleParameters } from '../lib/parameters.js'
import { canParticipate, isAdmin, useMe } from '../me.js'
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
  seasonId: string
  parameters: Record<string, ParameterValue>
  seasonLabel?: string
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
const multiSeat = computed(() => resolveLayout(props.meta, props.parameters).seatCount > 1)
const needsConfiguration = computed(() => multiSeat.value || visibleParameters(props.meta.parameters).length > 0)
const dialogOpen = ref(false)
const dialogPreselect = ref<AgentAssignmentInput | null>(null)
const dialogMode = ref<'rate' | 'watch'>('watch')

// An anonymous visitor keeps the watch/rate actions as the entry point into signing in: clicking
// one routes to /login instead of starting a run (which the backend would refuse anyway). Only a
// signed-in but still-pending account loses the actions, behind the awaiting-approval notice.
const anonymous = computed(() => me.me?.user == null)

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
  return maskedSubmissionLabel(agent.anonymous_number)
}

function actionLabel(agent: WatchAgentSummary): string {
  return agent.rating_status === 'unrated' ? 'Rate' : 'Watch again'
}

/** Watch a submitted agent: open the seat dialog (multi-seat) or start a one-seat run immediately. */
function watch(agent: WatchAgentSummary): void {
  chooseAgent(
    { kind: 'submission', submissionId: agent.submission_id },
    agent.submission_id,
    agent.rating_status === 'unrated' ? 'rate' : 'watch',
  )
}

/** Watch the built-in Naive agent: a scripted run with no submission. */
function watchBuiltin(): void {
  chooseAgent({ kind: 'builtin-agent' }, BUILTIN_KEY, 'watch')
}

/**
 * A clicked agent row resolves to a seat assignment and intent. A configurable environment opens the
 * dialog with that agent preselected into every seat; a fixed single-seat environment skips the
 * dialog and starts the scripted run right away, as the Stage 5 watch flow did.
 */
function chooseAgent(
  preselect: AgentAssignmentInput,
  loadingKey: string,
  mode: 'rate' | 'watch',
): void {
  if (anonymous.value) {
    void router.push('/login')
    return
  }
  if (needsConfiguration.value) {
    dialogPreselect.value = preselect
    dialogMode.value = mode
    startError.value = null
    dialogOpen.value = true
    return
  }
  void startRun(
    {
      seats: { seat_0: preselect },
      seasonId: props.seasonId,
      parameters: props.parameters,
    },
    loadingKey,
  )
}

/**
 * Start a watch run from a composed payload: the seat dialog's full `seats` (with its seed) for a
 * multi-seat environment, or a one-seat assignment for a single-seat one, then navigate to it,
 * reusing the rejoin / not-active / error handling.
 */
async function startRun(payload: StartPayload, loadingKey?: string): Promise<void> {
  startError.value = null
  if (loadingKey !== undefined) {
    starting.value = loadingKey
  }
  try {
    const result = await startSession({ envId: props.envId, ...payload })
    startError.value = await handleSessionStartResult(result, router)
    if (startError.value !== null) {
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
          v-if="anonymous || canParticipate(me.me)"
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
            <RouterLink
              class="agent-owner"
              :to="`/environments/${envId}/agents/${agent.owner_id}`"
              :title="agent.owner_id"
            >
              {{ agent.owner_name ?? agent.owner_id }}
            </RouterLink>
            <code class="agent-source">{{ sourceLabel(agent) }}</code>
          </template>
          <span v-else class="agent-name">{{ agentLabel(agent) }}</span>
          <UiBadge v-if="agent.rating_status === 'unrated'" variant="accent">Not rated</UiBadge>
          <UiBadge v-else-if="agent.rating_status === 'rated'">Rated</UiBadge>
        </div>
        <UiButton
          v-if="anonymous || canParticipate(me.me)"
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
    <UiEmptyState v-if="!anonymous && !canParticipate(me.me)">
      Your account is awaiting approval — watching unlocks once an admin approves you.
    </UiEmptyState>
    <p v-if="startError !== null" class="agent-error" role="alert">{{ startError }}</p>

    <!-- Rate locks the selected agent and all settings. Watch keeps the same configuration editable. -->
    <UiDialog
      v-model:open="dialogOpen"
      :title="`${dialogMode === 'rate' ? 'Rate' : 'Watch'} ${meta.display_name}${seasonLabel ? `: ${seasonLabel}` : ''}`"
    >
      <SeatAssignmentDialog
        v-if="dialogOpen && dialogPreselect !== null"
        :meta="meta"
        :agents="agents ?? []"
        :mode="dialogMode"
        :preselect="dialogPreselect"
        :is-operator="isAdmin(me.me)"
        :season-id="seasonId"
        :parameters="parameters"
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
