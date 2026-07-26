<!--
  The seat-assignment grid the watch and play flows open inside a UiDialog (Stage 7.6). It builds the
  explicit per-seat `seats` payload the backend's start contract expects: one assignment for
  every required seat. It is the multi-seat replacement for the Stage 5 single-agent watch start, used
  only for environments with more than one seat; a single-seat environment keeps its minimal forms.

  Every non-human seat always holds a concrete agent — there is no empty seat state. The built-in Naive
  baseline is the default agent (always available, even with no submissions), so a full, valid
  assignment always exists and Start stays enabled.

  - Rate mode: every seat is preselected to the intended agent and all configuration stays disabled.
  - Watch mode: every seat is an agent dropdown. Opening from an agent row preselects that agent into
    every seat (the parent passes it as `preselect`); the user may change individual seats.
  - Play mode: the connected human seats at the first human-capable seat by default and the rest default
    to Naive. Each non-human row has a "Sit here" button that moves the human to it, exactly one human
    at a time; the vacated row falls back to the Naive default agent.

  It is presentational: the parent owns the UiDialog, the `startSession` call, navigation, and errors.
  It emits `start` with the resolved `seats` and the supported session overrides, and `cancel`.
-->
<script setup lang="ts">
import {
  type EnvironmentMeta,
  type ParameterValue,
  resolveLayout,
} from '@game-sandbox/schema/environment'
import { computed, reactive, ref, watch } from 'vue'

import type {
  AgentAssignmentInput,
  SeatAssignmentInput,
  StartPayload,
  WatchAgentSummary,
} from '../api/client.js'
import { maskedSubmissionLabel } from '../lib/attribution.js'
import { shortId } from '../lib/format.js'
import { optionalNumber } from '../lib/forms.js'
import { initializeParameters, validateParameters } from '../lib/parameters.js'
import ParameterFields from './ParameterFields.vue'
import UiButton from './ui/UiButton.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'
import UiSelect from './ui/UiSelect.vue'

const props = defineProps<{
  meta: EnvironmentMeta
  /** The play-open season's active `ready` submissions, the seat dropdowns' submitted-agent options. */
  agents: WatchAgentSummary[]
  /** Rate locks one intended agent; watch assigns agents; play seats one connected human. */
  mode: 'rate' | 'watch' | 'play'
  /** The clicked agent to preselect into every seat (watch only); defaults to the Naive baseline. */
  preselect?: AgentAssignmentInput
  /** Operators see owner/source labels for submitted agents; everyone else sees anonymous numbers. */
  isOperator?: boolean
  seasonId: string
  parameters: Record<string, ParameterValue>
}>()

const emit = defineEmits<{
  start: [StartPayload]
  cancel: []
}>()

// Each seat's agent is a string (a <select> only carries strings): the Naive baseline or
// `submission:<id>`. The connected human seat is tracked separately by `humanSeat`, so a seat is never
// in an ambiguous "human-or-agent" string state. Decoded back to the wire union on Start.
const BUILTIN = 'builtin'

function encodeAgent(assignment: AgentAssignmentInput): string {
  return assignment.kind === 'submission' ? `submission:${assignment.submissionId}` : BUILTIN
}

function decodeAgent(value: string): AgentAssignmentInput {
  return value === BUILTIN
    ? { kind: 'builtin-agent' }
    : { kind: 'submission', submissionId: value.slice('submission:'.length) }
}

// A valid parameter map resolves to the exact seat ids and membership the backend validates against.
const parameters = ref(initializeParameters(props.meta.parameters, props.parameters))
const parametersValid = ref(true)
const layout = ref(resolveLayout(props.meta, parameters.value))
watch(parameters, (values) => {
  const checked = validateParameters(props.meta.parameters, values)
  if (Object.keys(checked.errors).length === 0) {
    layout.value = resolveLayout(props.meta, checked.values)
  }
})
const seatIds = computed(() => layout.value.seats.map((seat) => seat.seatId))
const seatsById = computed(
  () => new Map(layout.value.seats.map((seat) => [seat.seatId, seat] as const)),
)

// The seats a connected human may occupy, per the environment metadata. Hearts marks all four; a
// restricted environment may mark only some, so the human default and the "Sit here" affordance must
// respect it rather than offering the human every seat.
const humanPlayers = new Set(props.meta.human_players)
const humanCapableSeats = computed(
  () =>
    new Set(
      layout.value.seats
        .filter((seat) => seat.players.some((playerId) => humanPlayers.has(playerId)))
        .map((seat) => seat.seatId),
    ),
)

// Every seat carries a concrete agent under it; the human (play only) simply overrides whichever seat
// `humanSeat` names. Watch preselects the clicked agent into every seat; play defaults every seat to
// the Naive baseline and seats the human at the first human-capable seat. There is never an empty seat.
const defaultAgent =
  props.mode === 'play' ? BUILTIN : encodeAgent(props.preselect ?? { kind: 'builtin-agent' })
const agentChoice = reactive<Record<string, string>>(
  Object.fromEntries(seatIds.value.map((seatId) => [seatId, defaultAgent])),
)
// A companion must be an explicit choice. Keep it separately from the ordinary assignment beneath
// the human seat, because the two values have different wire meanings and different default rules.
const companionChoice = reactive<Record<string, string>>({})
const humanSeat = ref<string | null>(
  props.mode === 'play'
    ? (seatIds.value.find((seatId) => humanCapableSeats.value.has(seatId)) ?? null)
    : null,
)

function isHuman(seatId: string): boolean {
  return humanSeat.value === seatId
}

/** Whether a "Sit here" affordance belongs on this seat: play mode, and the seat is human-capable. */
function canSitHere(seatId: string): boolean {
  return props.mode === 'play' && humanCapableSeats.value.has(seatId)
}

// The strict index check types `agentChoice[seatId]` as `string | undefined`, but a seat always has a
// value, so this read keeps the dropdown binding and the payload typed.
function seatValue(seatId: string): string {
  return agentChoice[seatId] ?? BUILTIN
}

function setSeat(seatId: string, value: string): void {
  agentChoice[seatId] = value
}

function companionValue(seatId: string): string {
  return companionChoice[seatId] ?? ''
}

function setCompanion(seatId: string, value: string): void {
  companionChoice[seatId] = value
}

function seatPlayerCount(seatId: string): number {
  return seatsById.value.get(seatId)?.players.length ?? 0
}

function playerCountHint(seatId: string): string {
  const count = seatPlayerCount(seatId)
  return `${count} ${count === 1 ? 'player' : 'players'}`
}

/** Move the connected human to a seat; the seat it leaves falls back to the Naive default agent. */
function sitHere(target: string): void {
  if (humanSeat.value !== null) {
    agentChoice[humanSeat.value] = BUILTIN
  }
  humanSeat.value = target
  sanitizeChoices()
}

/** A short, human-friendly label for a submission's pinned source (operator view). */
function sourceLabel(agent: WatchAgentSummary): string {
  if (agent.commit_sha != null) {
    return agent.commit_sha.slice(0, 10)
  }
  return agent.source_kind === 'local' ? 'local folder' : 'git'
}

/** Name one submitted agent for the dropdown: own, operator owner/source, or anonymous number. */
function agentOptionLabel(agent: WatchAgentSummary): string {
  if (props.isOperator === true) {
    return `${agent.owner_name ?? shortId(agent.submission_id, 8)} · ${sourceLabel(agent)}`
  }
  if (agent.rating_status === 'own') {
    return 'Your agent'
  }
  return maskedSubmissionLabel(agent.anonymous_number)
}

// The agent options every seat dropdown offers: the always-available Naive baseline, then each ready
// submission. There is no empty option — a seat always names a concrete agent.
const agentOptions = computed<{ value: string; label: string }[]>(() => [
  { value: BUILTIN, label: 'Naive agent' },
  ...props.agents.map((agent) => ({
    value: `submission:${agent.submission_id}`,
    label: agentOptionLabel(agent),
  })),
])
const legalAgentValues = computed(() => new Set(agentOptions.value.map((option) => option.value)))

function sanitizeChoices(
  resolved = layout.value,
  legal = legalAgentValues.value,
): void {
  const ids = resolved.seats.map((seat) => seat.seatId)
  // A seat added by a growing count gets the same default as the seats present at open, so a watch or
  // rate dialog still has its chosen agent in every seat rather than Naive in the new ones.
  for (const seatId of ids) if (agentChoice[seatId] === undefined) agentChoice[seatId] = defaultAgent
  for (const seatId of Object.keys(agentChoice)) if (!ids.includes(seatId)) delete agentChoice[seatId]
  for (const [seatId, value] of Object.entries(agentChoice)) {
    if (!legal.has(value)) agentChoice[seatId] = ''
  }
  for (const seatId of Object.keys(companionChoice)) {
    const seat = resolved.seats.find((candidate) => candidate.seatId === seatId)
    const value = companionChoice[seatId]
    if (
      seat === undefined ||
      !isHuman(seatId) ||
      seat.players.length === 1 ||
      !legal.has(value ?? '')
    ) {
      delete companionChoice[seatId]
    }
  }
}

watch([layout, legalAgentValues], ([resolved, legal]) => {
  const ids = resolved.seats.map((seat) => seat.seatId)
  if (
    props.mode === 'play' &&
    (humanSeat.value === null ||
      !ids.includes(humanSeat.value) ||
      !humanCapableSeats.value.has(humanSeat.value))
  ) {
    humanSeat.value = ids.find((seatId) => humanCapableSeats.value.has(seatId)) ?? null
  }
  sanitizeChoices(resolved, legal)
})

// Start is gated on a full, valid composition: every seat carries an agent (always true with the
// no-empty defaults) and a play session has its one human seat. The guard keeps the payload honest.
const canStart = computed(() => {
  if (props.mode === 'play' && humanSeat.value === null) {
    return false
  }
  return (
    parametersValid.value &&
    seatIds.value.every((seatId) => {
      if (!isHuman(seatId)) {
        return legalAgentValues.value.has(seatValue(seatId))
      }
      return (
        seatPlayerCount(seatId) === 1 ||
        legalAgentValues.value.has(companionValue(seatId))
      )
    })
  )
})

const isPaced = props.meta.pace_interval_ms !== null
const configurationLocked = computed(() => props.mode === 'rate')
// The move clock is meaningful only with a connected human, so watch (all-agent) shows seed alone.
const showTimeout = props.mode === 'play'

const seed = ref<string | number>('')
// Prefill an unpaced environment's move clock from its metadata; a paced one starts blank.
const timeout = ref<string | number>(
  props.mode === 'play' && !isPaced && props.meta.human_timeout_ms !== null
    ? props.meta.human_timeout_ms
    : '',
)

const intro = computed(() => {
  if (props.mode === 'rate') {
    return 'This rating run uses the selected agent and season settings.'
  }
  return props.mode === 'watch'
    ? 'Assign an agent to each seat.'
    : 'Pick your seat; assign agents to the rest.'
})
const startLabel = computed(() => (props.mode === 'play' ? 'Start playing' : 'Start watching'))
const timeoutLabel = computed(() => (isPaced ? 'Per-step input window (ms)' : 'Move time limit (ms)'))
const timeoutHint = computed(() =>
  isPaced
    ? `Each step has a ${props.meta.pace_interval_ms} ms input window. A step with no input takes the ` +
      'default action. Leave blank to use the default.'
    : 'How long you may take to act each turn. Leave blank for the environment default.',
)

function onSubmit(): void {
  if (!canStart.value) {
    return
  }
  // Emit the normalized values, the same way the single-seat start form does, so both start paths put
  // one canonical representation of the same form state on the wire.
  const checked = validateParameters(props.meta.parameters, parameters.value)
  if (Object.keys(checked.errors).length > 0) return
  const seats: Record<string, SeatAssignmentInput> = {}
  for (const seatId of seatIds.value) {
    if (!isHuman(seatId)) {
      seats[seatId] = decodeAgent(seatValue(seatId))
      continue
    }
    const companion = companionValue(seatId)
    seats[seatId] =
      seatPlayerCount(seatId) === 1
        ? { kind: 'human' }
        : { kind: 'human', companion: decodeAgent(companion) }
  }
  emit('start', {
    seasonId: props.seasonId,
    parameters: checked.values,
    seats,
    seed: optionalNumber(seed.value),
    humanTimeoutMs: props.mode === 'play' ? optionalNumber(timeout.value) : undefined,
  })
}
</script>

<template>
  <form class="seat-form" @submit.prevent="onSubmit">
    <p class="seat-intro">{{ intro }}</p>

    <fieldset
      class="seat-configuration"
      :disabled="configurationLocked"
      aria-label="Session configuration"
    >
      <ParameterFields
        v-model="parameters"
        :declarations="meta.parameters"
        @validity="parametersValid = $event"
      />

      <ul class="seat-list">
        <li v-for="(seatId, index) in seatIds" :key="seatId" class="seat-row">
          <span :id="`${seatId}-label`" class="seat-label">Seat {{ index + 1 }}</span>
          <div class="seat-body">
            <div class="seat-control">
              <template v-if="isHuman(seatId)">
                <span class="seat-you">You</span>
                <span class="seat-seated">seated</span>
              </template>
              <template v-else>
                <UiSelect
                  :model-value="seatValue(seatId)"
                  :aria-labelledby="`${seatId}-label`"
                  @update:model-value="(value: string) => setSeat(seatId, value)"
                >
                  <option v-if="seatValue(seatId) === ''" value="" disabled>Select an agent</option>
                  <option v-for="option in agentOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </UiSelect>
                <UiButton
                  v-if="canSitHere(seatId)"
                  type="button"
                  variant="ghost"
                  size="tight"
                  @click="sitHere(seatId)"
                >
                  Sit here
                </UiButton>
              </template>
              <span class="player-count">{{ playerCountHint(seatId) }}</span>
            </div>
            <UiField
              v-if="isHuman(seatId) && seatPlayerCount(seatId) > 1"
              :label="`Companion agent for Seat ${index + 1}`"
              hint="Required. A separate instance controls each remaining player."
            >
              <template #default="{ id, describedby }">
                <UiSelect
                  :id="id"
                  :model-value="companionValue(seatId)"
                  required
                  :aria-describedby="describedby"
                  @update:model-value="(value: string) => setCompanion(seatId, value)"
                >
                  <option value="" disabled>Select a companion</option>
                  <option v-for="option in agentOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </UiSelect>
              </template>
            </UiField>
          </div>
        </li>
      </ul>

      <UiField label="Seed (optional)" hint="Leave blank for a random seed.">
        <template #default="{ id, describedby }">
          <UiInput
            :id="id"
            v-model="seed"
            type="number"
            min="0"
            placeholder="random"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>

      <UiField v-if="showTimeout" :label="timeoutLabel" :hint="timeoutHint">
        <template #default="{ id, describedby }">
          <UiInput
            :id="id"
            v-model="timeout"
            type="number"
            min="0"
            :placeholder="isPaced ? String(meta.pace_interval_ms) : 'default'"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>
    </fieldset>

    <div class="seat-form-actions">
      <UiButton type="submit" :disabled="!canStart">{{ startLabel }}</UiButton>
      <UiButton type="button" variant="ghost" @click="emit('cancel')">Cancel</UiButton>
    </div>
  </form>
</template>

<style scoped>
.seat-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.seat-intro {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.seat-configuration {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  border: 0;
}

.seat-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.seat-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: var(--space-3);
}

.seat-label {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.seat-body {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-2);
}

.seat-control {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.seat-you {
  color: var(--color-text);
  font-weight: 600;
}

.seat-seated {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.player-count {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.seat-form-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
