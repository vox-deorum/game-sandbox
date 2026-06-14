<!--
  The submitted-agent watch picker (Stage 5.6): lists the environment's active `ready` submitted
  agents and lets a viewer stream one into the renderer with no input controls. The list reads the
  active-iteration `ready` set, so superseded submissions stay profile history rather than watch
  choices. Choosing one starts a scripted watch run bound to that submission and navigates to the
  session; the backend enforces the allowlist, so a non-allowlisted viewer can browse the list (and
  open agent profiles) but the Watch action is gated, mirroring the page's play/watch entry points.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { listActiveSubmissions, startSession, type SubmissionSummary } from '../api/client.js'
import { useMe } from '../me.js'
import UiButton from './ui/UiButton.vue'
import UiEmptyState from './ui/UiEmptyState.vue'

const props = defineProps<{ envId: string }>()
const router = useRouter()
const me = useMe()

const agents = ref<SubmissionSummary[] | null>(null)
const startError = ref<string | null>(null)
// The submission a watch run is being started for, so only its button shows the loading state.
const starting = ref<string | null>(null)

onMounted(() => {
  listActiveSubmissions(props.envId, { status: 'ready' }).then(
    (rows) => {
      agents.value = rows
    },
    () => {
      agents.value = []
    },
  )
})

/** A short, human-friendly label for a submission's pinned source. */
function sourceLabel(agent: SubmissionSummary): string {
  if (agent.commit_sha !== null) {
    return agent.commit_sha.slice(0, 10)
  }
  return agent.source_kind === 'local' ? 'local folder' : 'git'
}

async function watch(agent: SubmissionSummary): Promise<void> {
  startError.value = null
  starting.value = agent.id
  try {
    const result = await startSession({ envId: props.envId, mode: 'scripted', submissionId: agent.id })
    if (result.ok) {
      await router.push(`/sessions/${result.session.id}`)
    } else if (result.reason === 'already_active') {
      // Rejoin rather than dead-end: the viewer already has a session running.
      await router.push(`/sessions/${result.activeSessionId}`)
    } else if (result.reason === 'not_allowlisted') {
      startError.value = 'You are not on the session allowlist.'
    } else {
      startError.value = result.message
    }
  } finally {
    starting.value = null
  }
}
</script>

<template>
  <UiEmptyState v-if="agents === null">Loading agents…</UiEmptyState>
  <UiEmptyState v-else-if="agents.length === 0">
    No submitted agents are ready to watch yet.
  </UiEmptyState>
  <template v-else>
    <ul class="agent-list">
      <li v-for="agent in agents" :key="agent.id" class="agent-row">
        <div class="agent-id">
          <RouterLink class="agent-owner" :to="`/environments/${envId}/agents/${agent.user_id}`">
            {{ agent.user_id }}
          </RouterLink>
          <code class="agent-source">{{ sourceLabel(agent) }}</code>
        </div>
        <UiButton
          v-if="me.me?.allowlisted"
          :loading="starting === agent.id"
          @click="watch(agent)"
        >
          Watch
        </UiButton>
      </li>
    </ul>
    <UiEmptyState v-if="!me.me?.allowlisted">
      Watching a submitted agent is limited to allowlisted users.
    </UiEmptyState>
    <p v-if="startError !== null" class="agent-error" role="alert">{{ startError }}</p>
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
