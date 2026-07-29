<!--
  The run controls of the operator console: trigger or re-run the workflow, cancel an in-flight run,
  and jump to the leaderboard. They close the run-configuration section, directly after its save
  button, because a run always uses the configuration that was last saved there. This is the console's
  control surface only: the per-run telemetry (games and the live container-log stream) lives on the
  run-details page (RunDetailsPage.vue). Triggering a run navigates straight to that page so the
  operator watches it stream; cancelling stays here and emits `changed` so the console reloads the
  latest-run status and the freshly settled boards.

  A `409 run_in_progress` surfaces as "a run is already in progress"; a `409 empty_schedule` points
  back at the match design. A saved configuration rejected at trigger time shows the backend's detail
  so the operator can correct it. Unsaved config edits prompt rather than block: a run reads the
  persisted config, so the operator confirms that the pending draft will not apply before the run starts.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'

import { cancelRun, type RunView, type SeasonView, triggerRun } from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiDialog from '../ui/UiDialog.vue'
import UiDialogActions from '../ui/UiDialogActions.vue'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

const props = defineProps<{
  season: SeasonView
  latestRun: RunView | null
  envId: string
  boardAvailable: boolean
  /** The config editor has unsaved edits; a run would use the stale persisted config. */
  configDirty: boolean
}>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const router = useRouter()

const triggering = ref(false)
const cancelling = ref(false)
const error = ref<string | null>(null)
// Open while the operator confirms a run against a configuration whose edits are not saved yet.
const unsavedOpen = ref(false)

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

/** Run at once on a saved configuration; on an unsaved one, ask before running the persisted design. */
function requestTrigger(): void {
  if (props.configDirty) {
    unsavedOpen.value = true
    return
  }
  void trigger()
}

/** Confirmed from the prompt: run the persisted config, then close so any error is readable. */
async function triggerUnsaved(): Promise<void> {
  await trigger()
  unsavedOpen.value = false
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
  } else if (result.reason === 'invalid_config' || result.reason === 'invalid_parameters') {
    error.value = `The saved configuration is invalid. ${result.message}. Update it, save it, then try again.`
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
      <UiButton :loading="triggering" :disabled="inProgress" @click="requestTrigger">
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
      <RouterLink
        v-if="latestRun !== null"
        class="run-status-link"
        :to="`/environments/${envId}/admin/seasons/${season.id}/runs/${latestRun.id}`"
      >
        <UiStatusBadge :tone="STATUS_TONE[latestRun.status]" :label="`${latestRun.status}`" />
      </RouterLink>
    </div>

    <p v-if="error" class="run-error" role="alert">{{ error }}</p>
    <p v-if="latestRun?.error" class="run-error">{{ latestRun.error }}</p>

    <UiDialog v-model:open="unsavedOpen" title="Run with unsaved configuration?">
      <p class="run-confirm-text">
        The configuration above has edits that are not saved. A run always uses the last saved
        configuration, so those edits will not apply to it. Cancel and save them first if the run
        should use them.
      </p>
      <UiDialogActions>
        <UiButton :loading="triggering" @click="triggerUnsaved">Run anyway</UiButton>
        <UiButton variant="ghost" :disabled="triggering" @click="unsavedOpen = false">
          Cancel
        </UiButton>
      </UiDialogActions>
    </UiDialog>
  </div>
</template>

<style scoped>
/* The panel follows the config editor's own action row, so it keeps that row's rhythm. */
.run-actions-panel {
  margin-top: var(--space-4);
}

.run-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.run-status-link {
  text-decoration: none;
  color: inherit;
  border-radius: var(--radius-sm);
}

.run-status-link:hover :deep(.label) {
  text-decoration: underline;
}

.run-error {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.run-confirm-text {
  margin: 0;
  color: var(--color-text);
}
</style>
