<!--
  The per-stage validation timeline (Stage 5.6), shared by the submit form (which polls a live
  submission) and the agent profile (which renders stored history). The four ordered pipeline stages
  read as a connected horizontal stepper: each stage is a node (passed / failed / running / not-yet-run)
  joined by a rail that fills green behind a passed stage, so the build's progress through the pipeline
  is legible at a glance. A stage with no check, or a skipped one, reads as not-yet-run. When
  `showDetail` is set (the profile), a failed stage also shows its captured detail below the track, so
  the owner sees which stage rejected and why, not just the rollup status. The track collapses to a
  vertical rail on narrow viewports.
-->
<script setup lang="ts">
import { computed, type Component } from 'vue'
import { Check, Circle, LoaderCircle, X } from '@lucide/vue'

import type { SubmissionCheck, SubmissionStage } from '../api/client.js'

const props = withDefaults(
  defineProps<{
    checks: SubmissionCheck[]
    /** Show a failed stage's captured detail beneath the track (the profile's per-stage rejection view). */
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

/** The rail leading into a node fills green once the stage before it has passed. */
function isRailDone(index: number): boolean {
  const previous = STAGES[index - 1]
  return previous !== undefined && stageState(previous.stage) === 'passed'
}

const STAGE_STATUS_LABEL: Record<StageState, string> = {
  pending: 'not started',
  running: 'running',
  passed: 'passed',
  failed: 'failed',
}

const ICON: Record<StageState, Component> = {
  pending: Circle,
  running: LoaderCircle,
  passed: Check,
  failed: X,
}

/** The failed stages with captured detail, rendered as a callout list below the track. */
const failedDetails = computed(() =>
  STAGES.map((item) => ({ ...item, detail: stageDetail(item.stage) })).filter(
    (item): item is { stage: SubmissionStage; label: string; detail: string } =>
      item.detail !== null,
  ),
)
</script>

<template>
  <div class="stage-stepper">
    <ol class="stepper-track">
      <li
        v-for="(item, index) in STAGES"
        :key="item.stage"
        :data-testid="`stage-${item.stage}`"
        class="stepper-step"
        :class="stageState(item.stage)"
      >
        <span v-if="index > 0" class="rail" :class="{ done: isRailDone(index) }" aria-hidden="true" />
        <span class="node">
          <component
            :is="ICON[stageState(item.stage)]"
            :size="14"
            aria-hidden="true"
            :class="{ spin: stageState(item.stage) === 'running' }"
          />
        </span>
        <span class="step-label">{{ item.label }}</span>
        <span class="step-status">{{ STAGE_STATUS_LABEL[stageState(item.stage)] }}</span>
      </li>
    </ol>

    <div v-if="showDetail && failedDetails.length > 0" class="stage-details">
      <p
        v-for="item in failedDetails"
        :key="item.stage"
        :data-testid="`stage-detail-${item.stage}`"
        class="stage-detail"
      >
        <span class="stage-detail-label">{{ item.label }}:</span> {{ item.detail }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.stepper-track {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}

.stepper-step {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  text-align: center;
  min-width: 0;
}

/* The rail spans from this node's center back to the previous node's center, sitting behind the
   nodes so their fills cover its ends. */
.rail {
  position: absolute;
  top: 0.875rem;
  right: 50%;
  width: 100%;
  height: 2px;
  transform: translateY(-50%);
  background: var(--color-border);
  z-index: 0;
}

.rail.done {
  background: var(--color-success);
}

.node {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: var(--radius-full);
  border: 2px solid var(--color-border-strong);
  background: var(--color-surface);
  color: var(--color-text-muted);
}

.stepper-step.passed .node {
  border-color: var(--color-success);
  background: var(--color-success);
  color: var(--color-on-accent);
}

.stepper-step.failed .node {
  border-color: var(--color-danger);
  background: var(--color-danger);
  color: var(--color-bg);
}

.stepper-step.running .node {
  border-color: var(--color-warning);
  color: var(--color-warning);
}

.step-label {
  font-size: var(--text-sm);
  line-height: 1.2;
  color: var(--color-text);
}

.step-status {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.stepper-step.passed .step-status {
  color: var(--color-success);
}

.stepper-step.failed .step-status {
  color: var(--color-danger);
}

.stepper-step.running .step-status {
  color: var(--color-warning);
}

.spin {
  animation: stepper-spin 1s linear infinite;
}

@keyframes stepper-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}

.stage-details {
  margin-top: var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.stage-detail {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--color-danger);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.stage-detail-label {
  margin-right: var(--space-2);
  font-weight: 600;
  color: var(--color-text);
}

/* Narrow viewports: the track stacks into a vertical rail, status pushed to the trailing edge. */
@media (max-width: 480px) {
  .stepper-track {
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }

  .stepper-step {
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    text-align: left;
  }

  .rail {
    top: auto;
    right: auto;
    bottom: 50%;
    left: 0.875rem;
    width: 2px;
    height: calc(100% + var(--space-3));
    transform: translateX(-50%);
  }

  .step-status {
    margin-left: auto;
  }
}
</style>
