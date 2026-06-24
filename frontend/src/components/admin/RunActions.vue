<!--
  The run controls of the operator console: trigger or re-run the workflow, cancel an in-flight run,
  and jump to the leaderboard. It is the console's control surface only — the per-run telemetry (games
  and the live container-log stream) lives on the run-details page (RunDetailsPage.vue). Triggering a
  run navigates straight to that page so the operator watches it stream; cancelling stays here and
  emits `changed` so the console reloads the latest-run status and the freshly settled boards.

  A `409 run_in_progress` surfaces as "a run is already in progress"; a `409 empty_schedule` points
  back at the match design. Unsaved match-design edits gate the trigger: a run reads the persisted
  config, so running on an unsaved draft would silently use the old design.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { cancelRun, type RunView, type SeasonView, triggerRun } from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

const props = defineProps<{
  season: SeasonView
  latestRun: RunView | null
  envId: string
  boardAvailable: boolean
  /** The config editor has unsaved match-design edits; a run would use the stale persisted design. */
  configDirty: boolean
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const router = useRouter()

const triggering = ref(false)
const cancelling = ref(false)
const error = ref<string | null>(null)

/** Whether the latest run is still executing, so a re-run is refused and a cancel is offered. */
const inProgress = computed(
  () => props.latestRun?.status === 'pending' || props.latestRun?.status === 'running',
)

const triggerLabel = computed(() => (props.latestRun === null ? 'Run workflow' : 'Re-run workflow'))

const STATUS_TONE: Record<RunView['status'], 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral',
  running: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

async function trigger(): Promise<void> {
  triggering.value = true
  error.value = null
  const result = await triggerRun(props.season.id)
  triggering.value = false
  if (result.ok) {
    // Hand off to the run-details page, which owns the live games/log stream for the new run.
    await router.push(
      `/environments/${props.envId}/admin/seasons/${props.season.id}/runs/${result.id}`,
    )
    return
  }
  if (result.reason === 'run_in_progress') {
    error.value = 'A run is already in progress for this season.'
  } else if (result.reason === 'empty_schedule') {
    error.value =
      'This season resolves to an empty schedule. Add at least one match in the match design before running.'
  } else {
    error.value = 'Could not start the run. Please try again.'
  }
}

async function cancel(): Promise<void> {
  if (props.latestRun === null) {
    return
  }
  cancelling.value = true
  error.value = null
  const result = await cancelRun(props.season.id, props.latestRun.id)
  cancelling.value = false
  if (result.ok) {
    emit('changed')
    return
  }
  error.value =
    result.reason === 'run_not_in_progress'
      ? 'That run is no longer in progress.'
      : 'Could not cancel the run.'
}
</script>

<template>
  <div class="run-actions-panel">
    <div class="run-actions">
      <UiButton :loading="triggering" :disabled="inProgress || configDirty" @click="trigger">
        {{ triggerLabel }}
      </UiButton>
      <UiButton v-if="inProgress" variant="danger" :loading="cancelling" @click="cancel">
        Cancel run
      </UiButton>
      <UiButton
        v-if="boardAvailable"
        variant="secondary"
        :to="`/environments/${envId}/leaderboards/${season.id}`"
      >
        Check leaderboard
      </UiButton>
      <UiButton v-else variant="secondary" disabled>Check leaderboard</UiButton>
      <UiStatusBadge
        v-if="latestRun !== null"
        :tone="STATUS_TONE[latestRun.status]"
        :label="`Run ${latestRun.status}`"
      />
    </div>

    <p v-if="configDirty" class="run-hint" role="status">
      Save the match design before running — a run uses the last saved configuration.
    </p>
    <p v-if="error" class="run-error" role="alert">{{ error }}</p>
    <p v-if="latestRun?.error" class="run-error">{{ latestRun.error }}</p>
  </div>
</template>

<style scoped>
.run-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.run-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.run-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
