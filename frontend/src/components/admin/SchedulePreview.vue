<!--
  The projected size of a season run, shown beside the match design while it is being edited.

  This reads only what the projection actually depends on: the draft's seat composition and game
  counts, plus the seat layout the environment parameters resolve to. It deliberately does not wait
  for the whole config to validate, so an unrelated invalid field elsewhere in the editor never
  blanks the preview. `projectSchedule` reports every structural problem in the draft itself with a
  typed reason, which this renders as an inline message rather than silently showing nothing.

  One box carries the counts or the reason there are none, never both. `blockedReason` covers what the
  arithmetic cannot see, such as a seat that no longer holds its designated builtin, and the default
  slot holds the action that fixes it.

  The count is arithmetic over the current draft, not a materialized schedule: triggering a run
  freezes a fresh eligible roster, so the number here is a page-load estimate.
-->
<script setup lang="ts">
import {
  type EnvironmentMeta,
  type ParameterValue,
  resolveLayout,
} from '@game-sandbox/schema/environment'
import {
  projectSchedule,
  type ScheduleMatchConfig,
  type ScheduleProjection,
  ScheduleProjectionError,
} from '@game-sandbox/schema/schedule'
import { computed } from 'vue'

import UiEmptyState from '../ui/UiEmptyState.vue'

const props = defineProps<{
  /** The draft match rows, exactly as the editor holds them. */
  matches: readonly ScheduleMatchConfig[]
  environment?: EnvironmentMeta
  /** The validated parameter values that select the seat layout. */
  parameterValues: Readonly<Record<string, ParameterValue>>
  eligibleSubmissionCount: number
  /** A reason the design cannot run that the projection arithmetic cannot see. The projection's own
   *  typed failure is the more specific message, so it wins when both apply. */
  blockedReason?: string | null
}>()

const resolvedLayout = computed(() => {
  if (props.environment === undefined) {
    return null
  }
  try {
    return resolveLayout(props.environment, props.parameterValues)
  } catch {
    return null
  }
})

const seatCount = computed(() => resolvedLayout.value?.seatCount ?? null)

/** Phrase one typed projection failure for an operator reading the match design. */
function errorMessage(error: ScheduleProjectionError, seats: number): string {
  const matchNumber = error.matchIndex === null ? null : error.matchIndex + 1
  switch (error.reason) {
    case 'seat_count_mismatch': {
      const draftSeats =
        error.matchIndex === null ? null : props.matches[error.matchIndex]?.seats.length
      return `Schedule projection unavailable: Match ${matchNumber} has ${draftSeats} seats, but the resolved layout has ${seats}.`
    }
    case 'unsafe_integer':
      return matchNumber === null
        ? 'Schedule projection unavailable: this design creates too many games to count safely.'
        : `Schedule projection unavailable: Match ${matchNumber} creates too many games to count safely.`
    case 'invalid_games':
      return `Schedule projection unavailable: Match ${matchNumber} has an invalid game count.`
    case 'invalid_eligible_submission_count':
      return 'Schedule projection unavailable: the eligible submission count is invalid.'
    case 'invalid_seat_count':
      return 'Schedule projection unavailable: the resolved seat count is invalid.'
  }
}

const state = computed<{ projection: ScheduleProjection | null; error: string | null }>(() => {
  const layout = resolvedLayout.value
  const environment = props.environment
  if (layout === null || environment === undefined) {
    return { projection: null, error: null }
  }
  try {
    return {
      projection: projectSchedule({
        matches: props.matches,
        eligibleSubmissionCount: props.eligibleSubmissionCount,
        seatCount: layout.seatCount,
        seatOrderMatters: environment.seat_order_matters,
      }),
      error: null,
    }
  } catch (error) {
    if (error instanceof ScheduleProjectionError) {
      return { projection: null, error: errorMessage(error, layout.seatCount) }
    }
    throw error
  }
})

const projection = computed(() => state.value.projection)
const blocked = computed(() => state.value.error ?? props.blockedReason ?? null)
</script>

<template>
  <UiEmptyState v-if="blocked !== null" tone="danger" role="alert" data-testid="projection-error">
    {{ blocked }}
    <span v-if="$slots.default" class="blocked-action"><slot /></span>
  </UiEmptyState>
  <div v-else-if="projection !== null" class="schedule-projection" aria-live="polite">
    <strong>Projected games: {{ projection.totalGames.toLocaleString() }}</strong>
    <span v-if="seatCount !== null">
      Resolved layout: {{ seatCount }} {{ seatCount === 1 ? 'seat' : 'seats' }}.
    </span>
    <span
      v-for="(matchProjection, matchIndex) in projection.matches"
      :key="matchIndex"
      data-testid="match-projection"
    >
      Match {{ matchIndex + 1 }}:
      {{ matchProjection.submittedAssignments.toLocaleString() }} submitted assignments and
      {{ matchProjection.naiveAssignments }} all-Naive assignment;
      {{ matchProjection.submittedGames.toLocaleString() }} submitted games and
      {{ matchProjection.naiveGames.toLocaleString() }} all-Naive games.
    </span>
    <span>
      Uses {{ eligibleSubmissionCount.toLocaleString() }} eligible
      {{ eligibleSubmissionCount === 1 ? 'submission' : 'submissions' }} as of page load. A run
      freezes a fresh roster when triggered.
    </span>
  </div>
</template>

<style scoped>
.schedule-projection {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.schedule-projection strong {
  color: var(--color-text);
  font-size: var(--text-md);
}

.blocked-action {
  margin-left: var(--space-2);
}
</style>
