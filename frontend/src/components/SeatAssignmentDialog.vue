<!--
  The seat-assignment grid the watch and play flows open inside a UiDialog (Stage 7.6). It builds the
  explicit per-seat `seats` payload the backend's start contract expects: one assignment for
  every required seat. It is the multi-seat replacement for the Stage 5 single-agent watch start, used
  only for environments with more than one seat; a single-seat environment keeps its minimal forms.

  Every non-human seat always holds a concrete agent. Unrestricted seats default to the built-in Naive
  baseline in Play, while restricted seats retain their designated built-in, so a full assignment
  always exists.

  - Rate mode: every unrestricted seat is preselected to the intended agent. A human-capable restricted
    seat defaults to Human, and only Human and its designated built-in agent remain enabled. A restricted
    seat with no human-capable player is locked. Session setting controls stay disabled.
    A rating run that seats the person is a session they play, so the intro and the start button say so.
  - Watch mode: every unrestricted seat is an agent dropdown preselected from the clicked agent row.
    Restricted seats stay locked to their designated built-in.
  - Play mode: the connected human defaults to the human-capable restricted seat when one exists, then
    to the first human-capable seat. Other unrestricted seats default to Naive, while restricted seats
    retain their designated built-in. "Sit here" moves the human and restores the vacated seat's default.

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
import SimultaneousWindowField from './SimultaneousWindowField.vue'
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
  /** The clicked agent to preselect into unrestricted seats (Watch and Rate); defaults to Naive. */
  preselect?: AgentAssignmentInput
  /** Operators see owner/source labels for submitted agents; everyone else sees anonymous numbers. */
  isOperator?: boolean
  seasonId: string
  parameters: Record<string, ParameterValue>
  /** The parent is creating the session. The submit button owns the visible pending state. */
  loading?: boolean
}>()

const emit = defineEmits<{
  start: [StartPayload]
  cancel: []
}>()

// Each seat's agent is a string because a <select> only carries strings: `builtin:<name>` or
// `submission:<id>`. The connected human seat is tracked separately by `humanSeat`, so a seat is
// never in an ambiguous "human-or-agent" string state. Decoded back to the wire union on Start.
const BUILTIN_PREFIX = 'builtin:'
const NAIVE_BUILTIN = `${BUILTIN_PREFIX}naive`
const SELF_COMPANION = 'self'

function encodeAgent(assignment: AgentAssignmentInput): string {
  return assignment.kind === 'submission'
    ? `submission:${assignment.submissionId}`
    : `${BUILTIN_PREFIX}${assignment.name}`
}

function decodeAgent(value: string): AgentAssignmentInput {
  return value.startsWith(BUILTIN_PREFIX)
    ? { kind: 'builtin-agent', name: value.slice(BUILTIN_PREFIX.length) }
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

function restrictedBuiltin(seatId: string): string | null {
  return seatsById.value.get(seatId)?.restrictedBuiltin ?? null
}

function fallbackAgent(seatId: string): string {
  const restricted = restrictedBuiltin(seatId)
  return restricted === null ? NAIVE_BUILTIN : `${BUILTIN_PREFIX}${restricted}`
}

function initialAgent(seatId: string): string {
  if (props.mode === 'play') return fallbackAgent(seatId)
  return restrictedBuiltin(seatId) === null
    ? encodeAgent(props.preselect ?? { kind: 'builtin-agent', name: 'naive' })
    : fallbackAgent(seatId)
}

// Every seat carries a concrete agent under it. A connected human overrides whichever seat
// `humanSeat` names. Restricted seats always retain their designated built-in when not human.
const agentChoice = reactive<Record<string, string>>(
  Object.fromEntries(seatIds.value.map((seatId) => [seatId, initialAgent(seatId)])),
)
// Keep an explicitly selected companion separately from the ordinary assignment beneath the human
// seat, because the two values have different wire meanings. A fully human-capable wide seat falls
// back to whole-seat human control when it has no explicit companion.
const companionChoice = reactive<Record<string, string>>({})

/**
 * The seat a connected human takes by default: a human-capable restricted seat first, since a
 * restricted seat has no other human-capable home, then any human-capable seat in Play. Rate stops at
 * the restricted seat, because a rating run without one is an ordinary all-agent session.
 */
function defaultHumanSeat(ids: readonly string[]): string | null {
  const restricted = ids.find(
    (seatId) => restrictedBuiltin(seatId) !== null && humanCapableSeats.value.has(seatId),
  )
  if (restricted !== undefined) return restricted
  if (props.mode !== 'play') return null
  return ids.find((seatId) => humanCapableSeats.value.has(seatId)) ?? null
}

const humanSeat = ref<string | null>(
  props.mode === 'watch' ? null : defaultHumanSeat(seatIds.value),
)

function isHuman(seatId: string): boolean {
  return humanSeat.value === seatId
}

/** Whether a "Sit here" affordance belongs on this seat: play mode, and the seat is human-capable. */
function canSitHere(seatId: string): boolean {
  return props.mode === 'play' && humanCapableSeats.value.has(seatId)
}

function isRestricted(seatId: string): boolean {
  return restrictedBuiltin(seatId) !== null
}

/**
 * Whether this seat is the human's and needs an explicit companion choice: it holds several players and
 * is unrestricted, so nothing derives who takes the others. A singleton or restricted human seat carries
 * no companion at all.
 */
function needsCompanionChoice(seatId: string): boolean {
  return isHuman(seatId) && seatPlayerCount(seatId) > 1 && !isRestricted(seatId)
}

/** A person may take every player of such a seat only when all of them are human-capable. */
function canPlaySeatYourself(seatId: string): boolean {
  const seat = seatsById.value.get(seatId)
  return (
    needsCompanionChoice(seatId) &&
    seat !== undefined &&
    seat.players.every((playerId) => humanPlayers.has(playerId))
  )
}

function isRestrictedHumanChoice(seatId: string): boolean {
  return props.mode === 'rate' && isRestricted(seatId) && humanCapableSeats.value.has(seatId)
}

function isSeatLocked(seatId: string): boolean {
  return props.mode === 'rate' ? !isRestrictedHumanChoice(seatId) : isRestricted(seatId)
}

// The strict index check types `agentChoice[seatId]` as `string | undefined`, but a seat always has a
// value, so this read keeps the dropdown binding and the payload typed.
function seatValue(seatId: string): string {
  return agentChoice[seatId] ?? NAIVE_BUILTIN
}

function setSeat(seatId: string, value: string): void {
  agentChoice[seatId] = value
}

function setRateRestrictedSeat(seatId: string, value: string): void {
  if (value === 'human') {
    humanSeat.value = seatId
    return
  }
  humanSeat.value = null
  agentChoice[seatId] = fallbackAgent(seatId)
}

function companionValue(seatId: string): string {
  return companionChoice[seatId] ?? (canPlaySeatYourself(seatId) ? SELF_COMPANION : '')
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

/** The seat's displayed name, the same one-based numbering the seat list renders. */
function seatName(seatId: string): string {
  return `Seat ${seatIds.value.indexOf(seatId) + 1}`
}

function restrictedBuiltinLabel(seatId: string): string {
  const name = restrictedBuiltin(seatId)
  return props.meta.builtin_agents.find((agent) => agent.name === name)?.label ?? name ?? ''
}

/** Move the connected human, restoring the vacated seat's Naive or designated-builtin default. */
function sitHere(target: string): void {
  if (humanSeat.value !== null) {
    agentChoice[humanSeat.value] = fallbackAgent(humanSeat.value)
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

// There is no empty option: a seat always names a concrete agent.
const agentOptions = computed<{ value: string; label: string }[]>(() => [
  ...props.meta.builtin_agents
    .map((agent) => ({
      value: `${BUILTIN_PREFIX}${agent.name}`,
      label: agent.label,
    })),
  ...props.agents.map((agent) => ({
    value: `submission:${agent.submission_id}`,
    label: agentOptionLabel(agent),
  })),
])
const legalAgentValues = computed(() => new Set(agentOptions.value.map((option) => option.value)))
const legalCompanionValues = computed(() => {
  const values = new Set(legalAgentValues.value)
  if (humanSeat.value !== null && canPlaySeatYourself(humanSeat.value)) {
    values.add(SELF_COMPANION)
  }
  return values
})

function sanitizeChoices(
  resolved = layout.value,
  legalAgents = legalAgentValues.value,
  legalCompanions = legalCompanionValues.value,
): void {
  const ids = resolved.seats.map((seat) => seat.seatId)
  // A seat added by a growing count gets the same mode default as the seats present at open.
  for (const seatId of ids) if (agentChoice[seatId] === undefined) agentChoice[seatId] = initialAgent(seatId)
  for (const seatId of Object.keys(agentChoice)) if (!ids.includes(seatId)) delete agentChoice[seatId]
  for (const [seatId, value] of Object.entries(agentChoice)) {
    if (isRestricted(seatId) && !isHuman(seatId)) {
      agentChoice[seatId] = fallbackAgent(seatId)
    } else if (!legalAgents.has(value)) {
      agentChoice[seatId] = ''
    }
  }
  // A seat keeps an explicit companion only while it still asks for one and the choice is still on
  // offer, so a grown, shrunk, or vacated seat never carries a stale value into the payload. Returning
  // to a fully human-capable wide seat then uses its whole-seat human-control default.
  for (const seatId of Object.keys(companionChoice)) {
    if (!needsCompanionChoice(seatId) || !legalCompanions.has(companionValue(seatId))) {
      delete companionChoice[seatId]
    }
  }
}

watch([layout, legalAgentValues, legalCompanionValues], ([resolved, legalAgents, legalCompanions]) => {
  const ids = resolved.seats.map((seat) => seat.seatId)
  // Only play keeps exactly one human seat at all times, so only play re-seats after a layout change.
  // Rate has no such invariant: a rating run may have no human seat, and a null one there is the
  // rater's own choice of the designated builtin rather than a seat waiting to be filled.
  if (
    props.mode === 'play' &&
    (humanSeat.value === null ||
      !ids.includes(humanSeat.value) ||
      !humanCapableSeats.value.has(humanSeat.value))
  ) {
    humanSeat.value = defaultHumanSeat(ids)
  }
  sanitizeChoices(resolved, legalAgents, legalCompanions)
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
        !needsCompanionChoice(seatId) || legalCompanionValues.value.has(companionValue(seatId))
      )
    })
  )
})

const isPaced = props.meta.pace_interval_ms !== null
const isSimultaneous = props.meta.stepping === 'simultaneous'
const configurationLocked = computed(() => props.mode === 'rate')
// The move clock is meaningful only with a connected human, so watch (all-agent) shows seed alone.
const showTimeout = props.mode === 'play' && !isSimultaneous

const seed = ref<string | number>('')
// Prefill an unpaced environment's move clock from its metadata; a paced one starts blank.
const timeout = ref<string | number>(
  props.mode === 'play' && !isPaced && props.meta.human_timeout_ms !== null
    ? props.meta.human_timeout_ms
    : '',
)

const intro = computed(() => {
  if (props.mode === 'rate') {
    const seated = humanSeat.value
    return seated === null
      ? 'This rating run uses the selected agent and season settings.'
      : `This rating run uses the selected agent and season settings. You play ${seatName(seated)}.`
  }
  return props.mode === 'watch'
    ? 'Assign an agent to each seat.'
    : 'Pick your seat; assign agents to the rest.'
})
// A session with a seated human is one the person plays, whichever flow opened this dialog. Rate can
// seat them on a human-capable restricted seat, so the label follows the composition, not the mode.
const startLabel = computed(() => (humanSeat.value === null ? 'Start watching' : 'Start playing'))
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
    if (!needsCompanionChoice(seatId)) {
      seats[seatId] = { kind: 'human' }
      continue
    }
    const companion = companionValue(seatId)
    seats[seatId] = {
      kind: 'human',
      companion: companion === SELF_COMPANION ? { kind: 'self' } : decodeAgent(companion),
    }
  }
  emit('start', {
    seasonId: props.seasonId,
    parameters: checked.values,
    seats,
    seed: optionalNumber(seed.value),
    humanTimeoutMs: showTimeout ? optionalNumber(timeout.value) : undefined,
  })
}
</script>

<template>
  <form class="seat-form" @submit.prevent="onSubmit">
    <p class="seat-intro">{{ intro }}</p>

    <fieldset class="seat-configuration" aria-label="Session configuration">
      <ParameterFields
        v-model="parameters"
        :declarations="meta.parameters"
        :presets="meta.presets"
        :disabled="configurationLocked"
        @validity="parametersValid = $event"
      />

      <ul class="seat-list">
        <li v-for="(seatId, index) in seatIds" :key="seatId" class="seat-row">
          <div class="seat-heading">
            <span :id="`${seatId}-label`" class="seat-label">Seat {{ index + 1 }}</span>
            <span class="player-count">{{ playerCountHint(seatId) }}</span>
          </div>
          <div class="seat-body">
            <div class="seat-control">
              <template v-if="isRestrictedHumanChoice(seatId)">
                <UiSelect
                  :model-value="isHuman(seatId) ? 'human' : fallbackAgent(seatId)"
                  :aria-labelledby="`${seatId}-label`"
                  @update:model-value="(value: string) => setRateRestrictedSeat(seatId, value)"
                >
                  <option value="human">Human</option>
                  <option :value="fallbackAgent(seatId)">{{ restrictedBuiltinLabel(seatId) }}</option>
                </UiSelect>
              </template>
              <template v-else-if="isHuman(seatId)">
                <span class="seat-you">You</span>
                <span class="seat-seated">seated</span>
              </template>
              <template v-else>
                <UiSelect
                  :model-value="seatValue(seatId)"
                  :aria-labelledby="`${seatId}-label`"
                  :disabled="isSeatLocked(seatId)"
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
            </div>
            <UiField
              v-if="needsCompanionChoice(seatId)"
              :label="`Seat ${index + 1}'s companions`"
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
                  <option v-if="legalCompanionValues.has(SELF_COMPANION)" :value="SELF_COMPANION">
                    Play them yourself
                  </option>
                  <option v-for="option in agentOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </UiSelect>
              </template>
            </UiField>
            <p
              v-else-if="isHuman(seatId) && seatPlayerCount(seatId) > 1"
              class="derived-companion"
            >
              {{ restrictedBuiltinLabel(seatId) }} controls the other players.
            </p>
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
            :disabled="configurationLocked"
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
            :disabled="configurationLocked"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>

      <SimultaneousWindowField
        v-else-if="isSimultaneous && humanSeat !== null"
        :pace-interval-ms="meta.pace_interval_ms"
      />
    </fieldset>

    <div class="seat-form-actions">
      <UiButton type="submit" :disabled="!canStart" :loading="loading">{{ startLabel }}</UiButton>
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

.seat-heading {
  display: flex;
  flex-direction: column;
  min-width: 5.5rem;
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

.derived-companion {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.seat-form-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
