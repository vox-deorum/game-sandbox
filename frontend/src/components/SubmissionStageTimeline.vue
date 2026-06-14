<!--
  The per-stage validation timeline (Stage 5.6), shared by the submit form (which polls a live
  submission) and the agent profile (which renders stored history). The four ordered pipeline stages
  each show a status badge built on the Stage 4.5 primitive; a stage with no check, or a skipped one,
  reads as not-yet-run. When `showDetail` is set (the profile), a failed stage also shows its captured
  detail inline, so the owner sees which stage rejected and why, not just the rollup status.
-->
<script setup lang="ts">
import type { SubmissionCheck, SubmissionStage } from '../api/client.js'
import UiStatusBadge from './ui/UiStatusBadge.vue'

const props = withDefaults(
  defineProps<{
    checks: SubmissionCheck[]
    /** Show a failed stage's captured detail beneath it (the profile's per-stage rejection view). */
    showDetail?: boolean
  }>(),
  { showDetail: false },
)

/** The ordered timeline stages and their owner-facing labels. */
const STAGES: { stage: SubmissionStage; label: string }[] = [
  { stage: 'resolve', label: 'Resolve source' },
  { stage: 'static', label: 'Static checks' },
  { stage: 'build', label: 'Build image' },
  { stage: 'load', label: 'Load check' },
]

type StageState = 'pending' | 'running' | 'passed' | 'failed'

/** The display state of a stage, derived from its check (absent or skipped reads as not-yet-run). */
function stageState(stage: SubmissionStage): StageState {
  const check = props.checks.find((c) => c.stage === stage)
  if (check === undefined || check.status === 'skipped') {
    return 'pending'
  }
  return check.status
}

/** A failed stage's captured detail, for the inline rejection view. */
function stageDetail(stage: SubmissionStage): string | null {
  const check = props.checks.find((c) => c.stage === stage)
  return check?.status === 'failed' ? check.detail : null
}

const STAGE_STATUS_LABEL: Record<StageState, string> = {
  pending: 'not started',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
}
const STAGE_STATUS_TONE: Record<StageState, 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral',
  running: 'warning',
  passed: 'success',
  failed: 'danger',
}
</script>

<template>
  <ol class="stage-timeline">
    <li v-for="item in STAGES" :key="item.stage" :data-testid="`stage-${item.stage}`" class="stage-row">
      <div class="stage-head">
        <span class="stage-label">{{ item.label }}</span>
        <UiStatusBadge
          :tone="STAGE_STATUS_TONE[stageState(item.stage)]"
          :label="STAGE_STATUS_LABEL[stageState(item.stage)]"
        />
      </div>
      <p
        v-if="showDetail && stageDetail(item.stage) !== null"
        :data-testid="`stage-detail-${item.stage}`"
        class="stage-detail"
      >
        {{ stageDetail(item.stage) }}
      </p>
    </li>
  </ol>
</template>

<style scoped>
.stage-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.stage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.stage-label {
  color: var(--color-text);
}

.stage-detail {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}
</style>
