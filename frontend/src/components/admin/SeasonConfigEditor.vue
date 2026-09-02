<!--
  The match-design config editor of the operator console (Stage 6.7). It edits the season's whole
  SeasonConfig: the match design (each match's seat composition of builtin:<name> / submission seats,
  its seeds, and its game count), the deps_version (defaulted to the current release at declaration),
  and the override blocks. The per-step / per-episode timeout, messaging, and LLM fields all map to
  the backend's strict season codec. Official and development LLM limits remain separate because
  they apply to different accounting scopes.

  Match rows follow the resolved seat layout: one selector per seat the row holds, and a restricted seat
  set to its designated built-in and disabled. Changing the seat plan or player count carries every row to
  the newly resolved layout. Nothing else rewrites a row, so opening a season and the environment
  metadata arriving both leave the stored seats exactly as saved. A row saved under an earlier layout
  keeps its seats until the operator conforms it with "Match the layout".

  The projection counts exactly what the draft would create: the eligible roster size in the section
  heading, the projected total below the matches, and each match's own share in its heading. One box
  carries the total or the single reason there is none, never both. Only the roster makes it an
  estimate, since triggering a run freezes a fresh one.

  A config edit once runs exist, or a deps_version change once submissions exist, is destructive. The
  first save attempt goes without `force`; the backend refuses it with a typed conflict, and the editor
  opens a confirmation dialog spelling out exactly what will be deleted before re-sending with `force`.
  Without that confirmation the edit does not happen. The environment seat-count errors come back as
  `invalid_config` and render inline.
-->
<script setup lang="ts">
import {
  type EnvironmentMeta,
  type EnvParameter,
  type EnvPreset,
  type ParameterValue,
  resolveLayout,
} from '@game-sandbox/schema/environment'
import { formatParameterValue, presetOverrides } from '@game-sandbox/schema/environment'
import { MODEL_ALIASES } from '@game-sandbox/schema/llm'
import {
  projectSchedule,
  type ScheduleProjection,
  ScheduleProjectionError,
} from '@game-sandbox/schema/schedule'
import { computed, ref, watch } from 'vue'

import {
  configureSeason,
  type LlmLimitOverride,
  type LlmModelAlias,
  type SeasonConfig,
  type SeasonOverrides,
  type SeasonView,
  type MatchConfig,
  type SeatSpec,
} from '../../api/client.js'
import { initializeParameters, validateParameters } from '../../lib/parameters.js'
import UiCheckboxGroup from '../ui/UiCheckboxGroup.vue'
import UiButton from '../ui/UiButton.vue'
import UiCard from '../ui/UiCard.vue'
import UiConfirmDialog from '../ui/UiConfirmDialog.vue'
import UiEmptyState from '../ui/UiEmptyState.vue'
import UiField from '../ui/UiField.vue'
import UiInput from '../ui/UiInput.vue'
import UiSelect from '../ui/UiSelect.vue'

const props = defineProps<{
  season: SeasonView
  eligibleSubmissionCount: number
  /** The registry entry for the season's environment: its messaging capability, its declared
   *  parameters, and the seat-order rule the schedule projection needs. */
  environment?: EnvironmentMeta
}>()

/** The environment's declared parameters, empty until the registry entry arrives. */
const environmentParameters = computed<readonly EnvParameter[]>(
  () => props.environment?.parameters ?? [],
)
const environmentPresets = computed<readonly EnvPreset[]>(() => props.environment?.presets ?? [])
const emit = defineEmits<{
  (e: 'changed', season: SeasonView): void
  /** Whether the form holds edits not yet persisted; drives the Run confirmation prompt upstream. */
  (e: 'dirty-change', dirty: boolean): void
}>()

const LLM_MODEL_ALIASES: readonly LlmModelAlias[] = MODEL_ALIASES

/** One match's editable form state; seeds are free text parsed to ints on save. */
interface MatchDraft {
  seats: SeatSpec[]
  seedsText: string
  games: number
}

const depsVersion = ref(props.season.config.deps_version)
const matches = ref<MatchDraft[]>([])
const stepTimeout = ref<number | ''>('')
const episodeTimeout = ref<number | ''>('')
// A season can inherit the environment's messaging capability or turn it off. An explicit `true`
// has the same runtime meaning as inheritance, so the editor canonicalizes it back to "default".
const messagingEnabled = ref<'default' | 'off'>('default')
const messagingDefaultLabel = computed(() =>
  props.environment === undefined
    ? 'Environment default'
    : `Environment default (${props.environment.messaging ? 'on' : 'off'})`,
)
/**
 * What an empty timeout field falls back to: the environment's own limit, named as a number so the
 * operator sees what leaving the field blank actually means. Stays the bare word until the
 * environment metadata arrives, since there is no number to show yet.
 */
function timeoutPlaceholder(limit: number | undefined): string {
  return limit === undefined ? 'default' : `default ${limit}`
}
const stepTimeoutPlaceholder = computed(() => timeoutPlaceholder(props.environment?.step_limit_ms))
const episodeTimeoutPlaceholder = computed(() =>
  timeoutPlaceholder(props.environment?.episode_limit_ms),
)
const llmEnabled = ref<'default' | 'on' | 'off'>('default')
const llmModelsMode = ref<'all' | 'medium-small' | 'small' | 'script-managed'>('all')
const llmModelsHint = computed(() => {
  if (llmModelsMode.value !== 'script-managed') return undefined
  const models = props.season.config.overrides?.llm?.models ?? []
  return `Current API-managed aliases: ${models.join(', ')}. Choose a preset to replace them.`
})
const officialTokenBudget = ref<number | ''>('')
const officialRateLimit = ref<number | ''>('')
const developmentTokenBudget = ref<number | ''>('')
const developmentRateLimit = ref<number | ''>('')
const parameterModes = ref<Record<string, 'inherit' | 'override'>>({})
const parameterValues = ref<Record<string, ParameterValue>>({})
const parameterValidation = computed(() =>
  validateParameters(environmentParameters.value, parameterValues.value),
)
/** The layout the current parameter values select, or null when they select none. */
const resolvedLayout = computed(() => {
  if (props.environment === undefined) return null
  try {
    return resolveLayout(props.environment, parameterValidation.value.values)
  } catch {
    return null
  }
})
/**
 * The layout's seats, and only while every parameter is valid: conforming a row to a layout derived
 * from a value the declarations rejected would write the wrong seats.
 */
const resolvedSeats = computed(() =>
  Object.keys(parameterValidation.value.errors).length > 0
    ? null
    : (resolvedLayout.value?.seats ?? null),
)
const seatOptions = computed<{ value: SeatSpec; label: string }[]>(() => [
  { value: 'submission', label: 'Submission' },
  ...(props.environment?.builtin_agents ?? []).map((builtin) => ({
    value: `builtin:${builtin.name}` as SeatSpec,
    label: builtin.label,
  })),
])
/** A stable key for the resolved layout: each seat's restriction in order, so both a width change and
 *  a restriction change move it. */
const layoutKey = computed(
  () => resolvedSeats.value?.map((seat) => seat.restrictedBuiltin ?? '').join('|') ?? null,
)
/** "1 seat", "3 seats": a count with its noun, pluralized by adding an s. */
function count(value: number, noun: string): string {
  return `${value.toLocaleString()} ${value === 1 ? noun : `${noun}s`}`
}

/** Phrase one typed projection failure for an operator reading the match design. */
function projectionMessage(error: ScheduleProjectionError, seats: number): string {
  const index = error.matchIndex
  const match = index === null ? 'this design' : `Match ${index + 1}`
  switch (error.reason) {
    case 'seat_count_mismatch': {
      const drafted = index === null ? 0 : (matches.value[index]?.seats.length ?? 0)
      return `Schedule projection unavailable: ${match} has ${count(drafted, 'seat')}, but the resolved layout has ${seats}.`
    }
    case 'unsafe_integer':
      return `Schedule projection unavailable: ${match} creates too many games to count safely.`
    case 'invalid_games':
      return `Schedule projection unavailable: ${match} has an invalid game count.`
    case 'invalid_eligible_submission_count':
      return 'Schedule projection unavailable: the eligible submission count is invalid.'
    case 'invalid_seat_count':
      return 'Schedule projection unavailable: the resolved seat count is invalid.'
  }
}

/**
 * The exact size of the run this draft would create, or the typed reason it cannot be counted. The
 * arithmetic reads only the seat composition, the game counts, and the resolved layout, so an invalid
 * field elsewhere in the editor never blanks it. It is an estimate in one respect: triggering a run
 * freezes a fresh eligible roster, so the roster it counts is the one loaded with the page.
 */
const projection = computed<{ totals: ScheduleProjection | null; error: string | null }>(() => {
  const layout = resolvedLayout.value
  const environment = props.environment
  if (layout === null || environment === undefined) return { totals: null, error: null }
  try {
    return {
      totals: projectSchedule({
        matches: matches.value.map((match) => ({ seats: match.seats, games: match.games })),
        eligibleSubmissionCount: props.eligibleSubmissionCount,
        seatCount: layout.seatCount,
        seatOrderMatters: environment.seat_order_matters,
      }),
      error: null,
    }
  } catch (error) {
    if (error instanceof ScheduleProjectionError) {
      return { totals: null, error: projectionMessage(error, layout.seatCount) }
    }
    throw error
  }
})

/** The projected total. Empty until the draft projects. */
const headline = computed(() => {
  const total = projection.value.totals?.totalGames
  return total === undefined ? '' : `Projected total: ${count(total, 'game')}`
})

/** One match's own share of the projected games, shown in its heading. Empty until the draft projects. */
function matchGames(matchIndex: number): string {
  const total = projection.value.totals?.matches[matchIndex]?.totalGames
  return total === undefined ? '' : `: ${count(total, 'game')}`
}

/**
 * The seats a match holds under the resolved layout: the layout's width, every restricted seat forced
 * to its designated built-in, every other seat kept at its current spec. Null when no layout resolves,
 * since there is then nothing to conform to. This is the one definition of a conformed row, shared by
 * drift detection, the conform action, a layout parameter change, and a newly added match.
 */
function conformedSeats(seats: readonly SeatSpec[]): SeatSpec[] | null {
  const layout = resolvedSeats.value
  if (layout === null) return null
  return layout.map((seat, index) =>
    seat.restrictedBuiltin === null
      ? (seats[index] ?? 'submission')
      : (`builtin:${seat.restrictedBuiltin}` as SeatSpec),
  )
}

/**
 * Whether any match row disagrees with the resolved layout in width or in a restricted seat. A season
 * saved under an earlier layout carries this until the operator resolves it, so opening the season and
 * the environment metadata arriving both leave the stored rows exactly as they are.
 */
const drifted = computed(() =>
  matches.value.some((match) => {
    const conformed = conformedSeats(match.seats)
    return conformed !== null && conformed.join() !== match.seats.join()
  }),
)

/**
 * The one reason the draft has no projected size, or null when it has one. The projection's own typed
 * failure is the more specific message, so it wins over drift when both apply.
 */
const blocked = computed(
  () =>
    projection.value.error ??
    (drifted.value ? 'A match no longer matches the resolved seat layout.' : null),
)

/** Conform every match row to the resolved layout. Reached only from an operator action. */
function conformLayout(): void {
  for (const match of matches.value) {
    const conformed = conformedSeats(match.seats)
    if (conformed !== null) match.seats.splice(0, match.seats.length, ...conformed)
  }
}

const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
// When the backend refuses a destructive edit, this holds the pending config and the reason so the
// confirmation dialog can spell out what `force` will delete before re-sending.
const confirm = ref<{
  config: SeasonConfig
  reason: 'season_has_runs' | 'season_has_submissions'
  deletesSubmissions: boolean
} | null>(null)

/** Seed the form from the season's config (and re-seed when the selected season changes). */
function seedFromSeason(): void {
  const config = props.season.config
  depsVersion.value = config.deps_version
  matches.value = config.matches.map((match) => ({
    seats: [...match.seats],
    seedsText: match.seeds.join(', '),
    games: match.games,
  }))
  stepTimeout.value = config.overrides?.step_timeout_ms ?? ''
  episodeTimeout.value = config.overrides?.episode_timeout_ms ?? ''
  const messaging = config.overrides?.messaging
  messagingEnabled.value = messaging?.enabled === false ? 'off' : 'default'
  const llm = config.overrides?.llm
  llmEnabled.value = llm?.enabled === undefined ? 'default' : llm.enabled ? 'on' : 'off'
  const models = llm?.models
  llmModelsMode.value =
    models === undefined
      ? 'all'
      : models.length === 2 && models.includes('medium') && models.includes('small')
        ? 'medium-small'
        : models.length === 1 && models[0] === 'small'
          ? 'small'
          : 'script-managed'
  officialTokenBudget.value = llm?.official?.token_budget ?? ''
  officialRateLimit.value = llm?.official?.rate_limit_rpm ?? ''
  developmentTokenBudget.value = llm?.development?.token_budget ?? ''
  developmentRateLimit.value = llm?.development?.rate_limit_rpm ?? ''
  seedParameters()
  saved.value = false
  error.value = null
}

/** Seed only the parameter rows, the part of the form that depends on the environment declarations. */
function seedParameters(): void {
  const declarations = environmentParameters.value
  const overrides = props.season.config.overrides?.parameters
  parameterValues.value = initializeParameters(declarations, overrides ?? {})
  parameterModes.value = Object.fromEntries(
    declarations.map((parameter) => [
      parameter.name,
      overrides?.[parameter.name] === undefined ? 'inherit' : 'override',
    ]),
  )
}

watch(() => props.season.id, seedFromSeason, { immediate: true })

// The declarations arrive from a separate environment-metadata request that settles independently of
// the season. Seed the rows it enables when it lands, but only while they are still empty: re-running
// the whole `seedFromSeason` here would discard every edit an operator made while that request was in
// flight, including the match, timeout, and LLM fields that have nothing to do with parameters.
watch(
  () => environmentParameters.value,
  () => {
    if (Object.keys(parameterModes.value).length === 0) seedParameters()
  },
)

function parameterHint(parameter: EnvParameter): string {
  if (parameter.type === 'int' || parameter.type === 'float') {
    return `${parameter.description} ${parameter.min}–${parameter.max}.`
  }
  return `${parameter.description}`
}

function updateParameter(name: string, value: unknown): void {
  const before = layoutKey.value
  parameterValues.value = { ...parameterValues.value, [name]: value as ParameterValue }
  // An edit that moves the resolved layout carries the match rows with it. Any other parameter edit
  // leaves them alone, so a row that already drifted stays drifted until the operator conforms it.
  if (layoutKey.value !== before) conformLayout()
}

// The picker only fills the rows: it names the preset applied last, and hand edits stay put.
const appliedParameterPreset = ref('')

function applyParameterPreset(name: string): void {
  const preset = environmentPresets.value.find((candidate) => candidate.name === name)
  if (preset === undefined) return

  appliedParameterPreset.value = name
  // A preset means the same override block in the seed and here: its named parameter values and,
  // when flagged, LLM enablement. Applying it fills every row from that one definition, so a preset
  // that does not set a field returns that field to its default just as it drops the override. A
  // preset can only express LLM enablement or leave it unset, never an explicit off, so a hand-set
  // "Explicitly disabled" stays put when a preset is applied for its parameter values.
  const overrides = presetOverrides(preset)
  const presetParameters = overrides?.parameters ?? {}
  const declarations = environmentParameters.value
  const before = layoutKey.value
  parameterModes.value = Object.fromEntries(
    declarations.map((parameter) => [
      parameter.name,
      Object.hasOwn(presetParameters, parameter.name) ? 'override' : 'inherit',
    ]),
  )
  parameterValues.value = initializeParameters(declarations, presetParameters)
  if (overrides?.llm?.enabled === true) {
    llmEnabled.value = 'on'
  } else if (llmEnabled.value !== 'off') {
    llmEnabled.value = 'default'
  }
  if (layoutKey.value !== before) conformLayout()
}

function addMatch(): void {
  matches.value.push({ seats: conformedSeats([]) ?? ['submission'], seedsText: '0', games: 1 })
}

function removeMatch(index: number): void {
  matches.value.splice(index, 1)
}

/**
 * Parse a free-text seed list ("0, 1 2") into integers. A blank field is the empty list, which the
 * backend treats as "draw fresh seeds per run"; any token that is not an integer is reported back
 * rather than dropped, so an operator never saves fewer seeds than they typed.
 */
function parseSeeds(text: string): { seeds: number[] } | { invalid: string } {
  const seeds: number[] = []
  for (const token of text.split(/[\s,]+/).filter((token) => token !== '')) {
    const value = Number(token)
    if (!Number.isInteger(value)) return { invalid: token }
    seeds.push(value)
  }
  return { seeds }
}

function buildLimitOverride(
  label: string,
  tokenBudget: number | '',
  rateLimit: number | '',
): { limits?: LlmLimitOverride; error?: string } {
  const values = [
    ['token budget', tokenBudget],
    ['rate limit', rateLimit],
  ] as const
  for (const [name, value] of values) {
    if (value !== '' && (!Number.isInteger(Number(value)) || Number(value) < 1)) {
      return { error: `The ${label} ${name} must be a positive integer.` }
    }
  }
  const limits: LlmLimitOverride = {}
  if (tokenBudget !== '') limits.token_budget = Number(tokenBudget)
  if (rateLimit !== '') limits.rate_limit_rpm = Number(rateLimit)
  return Object.keys(limits).length === 0 ? {} : { limits }
}

/** Build the config document from the form, or return a client-side validation message. */
function buildConfig(): { config: SeasonConfig } | { error: string } {
  const built: MatchConfig[] = []
  for (let i = 0; i < matches.value.length; i++) {
    const match = matches.value[i]!
    const parsed = parseSeeds(match.seedsText)
    if ('invalid' in parsed) {
      return {
        error: `Match ${i + 1} has a seed that is not an integer: "${parsed.invalid}". Leave the field blank for fresh random seeds.`,
      }
    }
    if (!Number.isInteger(match.games) || match.games < 1) {
      return { error: `Match ${i + 1} needs a game count of at least 1.` }
    }
    built.push({ seats: [...match.seats], seeds: parsed.seeds, games: match.games })
  }
  if (!Number.isInteger(depsVersion.value) || depsVersion.value < 1) {
    return { error: 'The dependency-set version must be a positive integer.' }
  }
  // Capability blocks stay absent when every field inherits its deployment or environment default.
  const overrides: NonNullable<SeasonConfig['overrides']> = {}
  if (stepTimeout.value !== '') overrides.step_timeout_ms = Number(stepTimeout.value)
  if (episodeTimeout.value !== '') overrides.episode_timeout_ms = Number(episodeTimeout.value)
  const messaging: NonNullable<SeasonOverrides['messaging']> = {}
  if (messagingEnabled.value === 'off') messaging.enabled = false
  if (Object.keys(messaging).length > 0) overrides.messaging = messaging
  const official = buildLimitOverride(
    'official',
    officialTokenBudget.value,
    officialRateLimit.value,
  )
  if (official.error !== undefined) return { error: official.error }
  const development = buildLimitOverride(
    'development',
    developmentTokenBudget.value,
    developmentRateLimit.value,
  )
  if (development.error !== undefined) return { error: development.error }
  const llm: NonNullable<SeasonOverrides['llm']> = {}
  if (llmEnabled.value !== 'default') llm.enabled = llmEnabled.value === 'on'
  const storedModels = props.season.config.overrides?.llm?.models
  if (llmModelsMode.value === 'script-managed' && storedModels !== undefined) {
    llm.models = [...storedModels]
  } else if (llmModelsMode.value !== 'all') {
    llm.models = llmModelsMode.value === 'medium-small' ? ['medium', 'small'] : ['small']
  }
  if (official.limits !== undefined) llm.official = official.limits
  if (development.limits !== undefined) llm.development = development.limits
  if (Object.keys(llm).length > 0) overrides.llm = llm
  const declared = environmentParameters.value
  const parameterOverrides: Record<string, ParameterValue> = {}
  // The same validation the rows render their inline errors from, so a save can never disagree with
  // what the form is already showing.
  const checked = parameterValidation.value
  for (const parameter of declared) {
    if (parameterModes.value[parameter.name] !== 'override') continue
    const value = checked.values[parameter.name]
    if (checked.errors[parameter.name] !== undefined || value === undefined) {
      return {
        error: `${parameter.title}: ${checked.errors[parameter.name] ?? 'Enter a valid value.'}`,
      }
    }
    parameterOverrides[parameter.name] = value
  }
  if (Object.keys(parameterOverrides).length > 0) overrides.parameters = parameterOverrides
  const config: SeasonConfig = { deps_version: depsVersion.value, matches: built }
  if (Object.keys(overrides).length > 0) {
    config.overrides = overrides
  }
  return { config }
}

/**
 * A canonical string for a config's *meaningful* content, so a dirty check ignores incidental
 * differences (seed-text spacing, override key order) and compares only what a save would persist.
 */
function canonicalConfig(config: SeasonConfig): string {
  return JSON.stringify({
    deps_version: config.deps_version,
    matches: config.matches.map((m) => ({ seats: m.seats, seeds: m.seeds, games: m.games })),
    overrides: canonicalOverrides(config.overrides),
  })
}

/** Collapse an override object with no effective fields to the same meaning as an absent object. */
function canonicalOverrides(overrides: SeasonConfig['overrides']): Record<string, unknown> | null {
  if (overrides === undefined) return null
  const normalized = {
    step_timeout_ms: overrides.step_timeout_ms ?? null,
    episode_timeout_ms: overrides.episode_timeout_ms ?? null,
    messaging: canonicalMessaging(overrides.messaging),
    llm: canonicalLlm(overrides.llm),
    parameters: canonicalParameters(overrides.parameters),
  }
  return Object.values(normalized).every((value) => value === null) ? null : normalized
}

/**
 * Normalize the declared overrides a config actually carries, so dirty tracking compares meaning
 * rather than representation (multi-choice ordering, integers written as floats).
 */
function canonicalParameters(
  parameters: SeasonOverrides['parameters'],
): Record<string, ParameterValue> | null {
  if (parameters === undefined) return null
  const declarations = (environmentParameters.value).filter(
    (declaration) => parameters[declaration.name] !== undefined,
  )
  const { values } = validateParameters(declarations, parameters)
  return Object.keys(values).length === 0 ? null : values
}

/** Normalize explicit messaging enablement because `true` and inheritance resolve identically. */
function canonicalMessaging(
  messaging: SeasonOverrides['messaging'],
): Record<string, unknown> | null {
  if (messaging === undefined) return null
  const enabled = messaging.enabled === false ? false : null
  return enabled === null ? null : { enabled }
}

/**
 * Normalize a stored LLM override to the exact key/alias order `buildConfig` emits. Script-stored
 * fields the console cannot edit must not read as a permanent unsaved edit that prompts on every run.
 */
function canonicalLlm(llm: SeasonOverrides['llm']): Record<string, unknown> | null {
  if (llm === undefined) return null
  const normalized = {
    enabled: llm.enabled ?? null,
    models:
      llm.models === undefined
        ? null
        : LLM_MODEL_ALIASES.filter((alias) => llm.models?.includes(alias)),
    official: canonicalLimits(llm.official),
    development: canonicalLimits(llm.development),
  }
  return Object.values(normalized).every((value) => value === null) ? null : normalized
}

function canonicalLimits(limits: LlmLimitOverride | undefined): Record<string, unknown> | null {
  if (limits === undefined) return null
  return {
    token_budget: limits.token_budget ?? null,
    rate_limit_rpm: limits.rate_limit_rpm ?? null,
  }
}

/**
 * Whether the form differs from the saved season config. An incomplete/invalid draft (e.g. a match
 * mid-edit with a game count below 1) counts as dirty: it still needs a save, and a run must warn
 * about it.
 */
const dirty = computed(() => {
  const result = buildConfig()
  if ('error' in result) {
    return true
  }
  return canonicalConfig(result.config) !== canonicalConfig(props.season.config)
})

// Surface the dirty state to the console so "Run workflow" can confirm before using the saved design.
watch(dirty, (value) => emit('dirty-change', value), { immediate: true })

async function save(): Promise<void> {
  const result = buildConfig()
  if ('error' in result) {
    error.value = result.error
    return
  }
  await send(result.config, false)
}

/** Send the config; a destructive-edit conflict opens the confirmation dialog instead of failing. */
async function send(config: SeasonConfig, force: boolean): Promise<void> {
  saving.value = true
  saved.value = false
  error.value = null
  const result = await configureSeason(props.season.id, config, force)
  saving.value = false
  if (result.ok) {
    confirm.value = null
    saved.value = true
    emit('changed', result.season)
    return
  }
  if (result.reason === 'season_has_runs' || result.reason === 'season_has_submissions') {
    // The backend reports existing runs before it checks whether a dependency-version change also
    // invalidates submissions. Derive that second consequence from the edit itself so the operator
    // sees the complete deletion set before approving `force`.
    confirm.value = {
      config,
      reason: result.reason,
      deletesSubmissions: config.deps_version !== props.season.config.deps_version,
    }
    return
  }
  error.value =
    result.reason === 'invalid_config'
      ? `The configuration was rejected: ${result.message}`
      : 'Could not save the configuration. Please try again.'
}

async function confirmForce(): Promise<void> {
  if (confirm.value === null) {
    return
  }
  await send(confirm.value.config, true)
}

const confirmOpen = ref(false)
watch(confirm, (value) => {
  confirmOpen.value = value !== null
})
watch(confirmOpen, (open) => {
  if (!open) {
    confirm.value = null
  }
})
</script>

<template>
  <div class="config">
    <UiCard aria-labelledby="match-design-title">
      <h3 id="match-design-title" class="config-title">
        Match Design: {{ count(props.eligibleSubmissionCount, 'submission') }}
      </h3>

    <UiField label="Dependency-set version" hint="Defaults to the current template release.">
      <template #default="{ id }">
        <UiInput :id="id" v-model.number="depsVersion" type="number" min="1" />
      </template>
    </UiField>

    <ol class="match-list">
      <li v-for="(match, matchIndex) in matches" :key="matchIndex" class="match" data-testid="match">
        <div class="match-head">
          <span class="match-label">Match {{ matchIndex + 1 }}{{ matchGames(matchIndex) }}</span>
          <UiButton variant="ghost" size="tight" @click="removeMatch(matchIndex)">
            Remove match
          </UiButton>
        </div>

        <div class="seats">
          <div
            v-for="(spec, seatIndex) in match.seats"
            :key="seatIndex"
            class="seat"
            data-testid="seat"
          >
            <span class="seat-number">Seat {{ seatIndex + 1 }}</span>
            <UiSelect
              :model-value="spec"
              :aria-label="`Seat ${seatIndex + 1}`"
              :disabled="resolvedSeats?.[seatIndex]?.restrictedBuiltin != null"
              @update:model-value="(value) => (match.seats[seatIndex] = value as SeatSpec)"
            >
              <option v-for="option in seatOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </UiSelect>
          </div>
        </div>

        <div class="match-fields">
          <UiField
            label="Seeds"
            hint="Comma-separated integers. Leave blank to draw fresh seeds on every run."
          >
            <template #default="{ id }">
              <UiInput :id="id" v-model="match.seedsText" type="text" placeholder="0, 1" />
            </template>
          </UiField>
          <UiField label="Games" hint="Games per resolved assignment.">
            <template #default="{ id }">
              <UiInput :id="id" v-model.number="match.games" type="number" min="1" />
            </template>
          </UiField>
        </div>
      </li>
    </ol>
    <UiEmptyState v-if="blocked !== null" tone="danger" role="alert" data-testid="projection-error">
      {{ blocked }}
      <UiButton
        v-if="drifted"
        variant="secondary"
        size="tight"
        class="blocked-action"
        @click="conformLayout"
      >
        Match the layout
      </UiButton>
    </UiEmptyState>
    <p v-else-if="headline !== ''" class="schedule-projection" aria-live="polite">
      <strong>{{ headline }}</strong>
    </p>
    <UiButton variant="secondary" size="tight" @click="addMatch">Add match</UiButton>
    </UiCard>

    <UiCard aria-labelledby="session-behavior-title">
      <h3 id="session-behavior-title" class="config-title">Session Behavior</h3>
      <div class="match-fields">
      <UiField label="Step timeout (ms)">
        <template #default="{ id }">
          <UiInput
            :id="id"
            v-model.number="stepTimeout"
            type="number"
            min="1"
            :placeholder="stepTimeoutPlaceholder"
          />
        </template>
      </UiField>
      <UiField label="Per-player timeout (ms)">
        <template #default="{ id }">
          <UiInput
            :id="id"
            v-model.number="episodeTimeout"
            type="number"
            min="1"
            :placeholder="episodeTimeoutPlaceholder"
          />
        </template>
      </UiField>
      <UiField
        label="Messaging"
      >
        <template #default="{ id }">
          <UiSelect :id="id" v-model="messagingEnabled">
            <option value="default">{{ messagingDefaultLabel }}</option>
            <option value="off">Off</option>
          </UiSelect>
        </template>
      </UiField>
      </div>
    </UiCard>

    <UiCard aria-labelledby="llm-config-title">
      <h3 id="llm-config-title" class="config-title">LLM Access</h3>
      <div class="match-fields">
        <UiField
          label="LLM enablement"
          hint="A season must explicitly enable LLM access."
        >
          <template #default="{ id }">
            <UiSelect :id="id" v-model="llmEnabled">
              <option value="default">Not set (disabled)</option>
              <option value="on">Enabled</option>
              <option value="off">Explicitly disabled</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField label="Allowed model aliases" :hint="llmModelsHint">
          <template #default="{ id, describedby }">
            <UiSelect :id="id" v-model="llmModelsMode" :aria-describedby="describedby">
              <option value="all">All of them</option>
              <option value="medium-small">Medium and small only</option>
              <option value="small">Small only</option>
            </UiSelect>
          </template>
        </UiField>
      </div>

      <div class="limit-groups">
        <fieldset class="limit-group">
          <legend>Per-player limits</legend>
          <UiField label="Per-player token budget">
            <template #default="{ id }">
              <UiInput
                :id="id"
                v-model.number="officialTokenBudget"
                type="number"
                min="1"
                placeholder="default"
              />
            </template>
          </UiField>
          <UiField label="Per-player rate limit (RPM)">
            <template #default="{ id }">
              <UiInput
                :id="id"
                v-model.number="officialRateLimit"
                type="number"
                min="1"
                placeholder="default"
              />
            </template>
          </UiField>
        </fieldset>

        <fieldset class="limit-group">
          <legend>Development per-participant limits</legend>
          <UiField label="Development token budget">
            <template #default="{ id }">
              <UiInput
                :id="id"
                v-model.number="developmentTokenBudget"
                type="number"
                min="1"
                placeholder="default"
              />
            </template>
          </UiField>
          <UiField
            label="Development rate limit (RPM)"
          >
            <template #default="{ id }">
              <UiInput
                :id="id"
                v-model.number="developmentRateLimit"
                type="number"
                min="1"
                placeholder="default"
              />
            </template>
          </UiField>
        </fieldset>
      </div>
    </UiCard>

    <UiCard
      v-if="environmentParameters.length > 0"
      aria-labelledby="environment-parameters-title"
    >
      <h3 id="environment-parameters-title" class="config-title">Environment Parameters</h3>
      <UiField v-if="environmentPresets.length > 0" label="Preset">
        <template #default="{ id, describedby }">
          <UiSelect
            :id="id"
            :model-value="appliedParameterPreset"
            :aria-describedby="describedby"
            @update:model-value="applyParameterPreset"
          >
            <option value="" disabled>Choose a preset</option>
            <option v-for="preset in environmentPresets" :key="preset.name" :value="preset.name">
              {{ preset.title }}
            </option>
          </UiSelect>
        </template>
      </UiField>
      <div v-for="parameter in environmentParameters" :key="parameter.name" class="parameter-row">
        <UiField :label="parameter.title" :hint="parameterHint(parameter)">
          <template #default="{ id }">
            <UiSelect
              :id="id"
              :model-value="parameterModes[parameter.name] ?? 'inherit'"
              @update:model-value="(value) => (parameterModes[parameter.name] = value as 'inherit' | 'override')"
            >
              <option value="inherit">
                Environment default ({{ formatParameterValue(parameter, parameter.default) }})
              </option>
              <option value="override">Override</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField
          v-if="parameterModes[parameter.name] === 'override' && (parameter.type === 'int' || parameter.type === 'float' || parameter.type === 'string')"
          :label="`${parameter.title} override`"
          :error="parameterValidation.errors[parameter.name]"
        >
          <template #default="{ id, describedby, invalid }">
            <UiInput
              :id="id"
              :model-value="parameterValues[parameter.name] as string | number"
              :type="parameter.type === 'string' ? 'text' : 'number'"
              :min="parameter.type === 'string' ? undefined : parameter.min"
              :max="parameter.type === 'string' ? undefined : parameter.max"
              :step="parameter.type === 'float' ? 'any' : undefined"
              :invalid="invalid"
              :aria-describedby="describedby"
              @update:model-value="(value) => updateParameter(parameter.name, parameter.type === 'string' || value === '' ? value : Number(value))"
            />
          </template>
        </UiField>
        <UiField
          v-else-if="parameterModes[parameter.name] === 'override' && parameter.type === 'bool'"
          :label="`${parameter.title} override`"
        >
          <template #default="{ id, describedby }">
            <UiSelect
              :id="id"
              :model-value="parameterValues[parameter.name] === true ? 'on' : 'off'"
              :aria-describedby="describedby"
              @update:model-value="(value) => updateParameter(parameter.name, value === 'on')"
            >
              <option value="on">On</option>
              <option value="off">Off</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField
          v-else-if="parameterModes[parameter.name] === 'override' && parameter.type === 'choice'"
          :label="`${parameter.title} override`"
          :error="parameterValidation.errors[parameter.name]"
        >
          <template #default="{ id, describedby, invalid }">
            <UiSelect
              :id="id"
              :model-value="String(parameterValues[parameter.name] ?? '')"
              :invalid="invalid"
              :aria-describedby="describedby"
              @update:model-value="(value) => updateParameter(parameter.name, value)"
            >
              <option v-for="choice in parameter.choices" :key="choice.value" :value="choice.value">
                {{ choice.label }}
              </option>
            </UiSelect>
          </template>
        </UiField>
        <UiCheckboxGroup
          v-else-if="parameterModes[parameter.name] === 'override' && parameter.type === 'multi_choice'"
          :model-value="Array.isArray(parameterValues[parameter.name]) ? parameterValues[parameter.name] as string[] : []"
          :legend="`${parameter.title} override`"
          :options="parameter.choices"
          :error="parameterValidation.errors[parameter.name]"
          @update:model-value="(value) => updateParameter(parameter.name, value)"
        />
      </div>
    </UiCard>

    <div class="config-actions">
      <UiButton :loading="saving" @click="save">Save configuration</UiButton>
      <span v-if="dirty" class="config-dirty" role="status">● Unsaved changes</span>
      <span v-else-if="saved" class="config-saved" role="status">Saved ✓</span>
      <!-- The run controls join this row: a run uses the configuration last saved from it. -->
      <slot name="actions" />
      <span v-if="error" class="config-error" role="alert">{{ error }}</span>
    </div>

    <UiConfirmDialog
      v-model:open="confirmOpen"
      title="Confirm a destructive edit"
      confirm-label="Delete and save"
      confirm-variant="danger"
      :confirm-loading="saving"
      cancel-label="Cancel"
      @confirm="confirmForce"
    >
      <p class="confirm-text">
        <template v-if="confirm?.deletesSubmissions">
          Changing the dependency-set version deletes this season's submissions (they were built
          against the old dependency set), along with its existing runs and boards.
        </template>
        <template v-else-if="confirm?.reason === 'season_has_runs'">
          This season already has runs. Saving a new configuration deletes its existing runs and
          boards so they can be recomputed from the new design.
        </template>
      </p>
    </UiConfirmDialog>
  </div>
</template>

<style scoped>
.config {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.config-title {
  margin: 0 0 var(--space-2);
}

.match-list {
  list-style: none;
  margin: var(--space-4) 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.match {
  padding: var(--space-4) 0;
  border-top: 1px solid var(--color-border);
}

.match-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-3);
}

.match-label {
  font-weight: 600;
}

.seats {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.seat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.seat-number {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.schedule-projection {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
}

.blocked-action {
  margin-left: var(--space-2);
}

.match-fields {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.limit-group {
  margin: var(--space-4) 0 0;
  padding: var(--space-4) 0 0;
  border: 0;
  border-top: 1px solid var(--color-border);
}

.limit-group legend {
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: 600;
}

.limit-groups,
.parameter-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: var(--space-4);
}

.limit-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.parameter-row {
  padding: var(--space-3) 0;
  border-top: 1px solid var(--color-border);
}

.config-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.config-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}

.config-dirty {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-accent);
}

/* A full basis takes the whole line of the action row, so the message sits under the buttons. */
.config-error {
  flex-basis: 100%;
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.confirm-text {
  margin: 0;
  color: var(--color-text);
}
</style>
