<!--
  The match-design config editor of the operator console (Stage 6.7). It edits the season's whole
  SeasonConfig: the match design (each match's slot composition of builtin-naive / submission seats,
  its seeds, and its game count), the deps_version (defaulted to the current release at declaration),
  and the override blocks. The per-step / per-episode timeout, messaging, and LLM fields all map to
  the backend's strict season codec. Official and development LLM limits remain separate because
  they apply to different accounting scopes.

  Two guards, mirroring the step-3 contract:
  - A match with zero slots is never saved (the editor refuses it before the request).
  - A config edit once runs exist, or a deps_version change once submissions exist, is destructive. The
    first save attempt goes without `force`; the backend refuses it with a typed conflict, and the
    editor opens a confirmation dialog spelling out exactly what will be deleted before re-sending with
    `force`. Without that confirmation the edit does not happen. The environment slot-count errors come
    back as `invalid_config` and render inline.
-->
<script setup lang="ts">
import { MODEL_ALIASES } from '@game-sandbox/schema/llm'
import { computed, ref, watch } from 'vue'

import {
  configureSeason,
  type LlmLimitOverride,
  type LlmModelAlias,
  type SeasonConfig,
  type SeasonOverrides,
  type SeasonView,
  type MatchConfig,
  type SlotSpec,
} from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiDialog from '../ui/UiDialog.vue'
import UiField from '../ui/UiField.vue'
import UiInput from '../ui/UiInput.vue'
import UiSelect from '../ui/UiSelect.vue'

const props = defineProps<{ season: SeasonView }>()
const emit = defineEmits<{
  (e: 'changed', season: SeasonView): void
  /** Whether the form holds match-design edits not yet persisted; drives the Run gate upstream. */
  (e: 'dirty-change', dirty: boolean): void
}>()

const SLOT_SPECS: SlotSpec[] = ['submission', 'builtin-naive']
const LLM_MODEL_ALIASES: readonly LlmModelAlias[] = MODEL_ALIASES

/** One match's editable form state; seeds are free text parsed to ints on save. */
interface MatchDraft {
  slots: SlotSpec[]
  seedsText: string
  games: number
}

const depsVersion = ref(props.season.config.deps_version)
const matches = ref<MatchDraft[]>([])
const stepTimeout = ref<number | ''>('')
const episodeTimeout = ref<number | ''>('')
// The messaging override's `enabled` is an *optional* boolean, so the toggle has three states:
// "default" leaves the environment's own setting in force, "on"/"off" write an explicit boolean.
const messagingEnabled = ref<'default' | 'on' | 'off'>('default')
const messageCap = ref<number | ''>('')
const llmEnabled = ref<'default' | 'on' | 'off'>('default')
const llmModelsMode = ref<'all' | 'custom'>('all')
const llmModels = ref<LlmModelAlias[]>([])
const officialTokenBudget = ref<number | ''>('')
const officialCallBudget = ref<number | ''>('')
const officialRateLimit = ref<number | ''>('')
const developmentTokenBudget = ref<number | ''>('')
const developmentCallBudget = ref<number | ''>('')
const developmentRateLimit = ref<number | ''>('')

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
    slots: [...match.slots],
    seedsText: match.seeds.join(', '),
    games: match.games,
  }))
  stepTimeout.value = config.overrides?.step_timeout_ms ?? ''
  episodeTimeout.value = config.overrides?.episode_timeout_ms ?? ''
  const messaging = config.overrides?.messaging
  messagingEnabled.value = messaging?.enabled === undefined ? 'default' : messaging.enabled ? 'on' : 'off'
  messageCap.value = messaging?.message_cap ?? ''
  const llm = config.overrides?.llm
  llmEnabled.value = llm?.enabled === undefined ? 'default' : llm.enabled ? 'on' : 'off'
  llmModelsMode.value = llm?.models === undefined ? 'all' : 'custom'
  llmModels.value = [...(llm?.models ?? [])]
  officialTokenBudget.value = llm?.official?.token_budget ?? ''
  officialCallBudget.value = llm?.official?.call_budget ?? ''
  officialRateLimit.value = llm?.official?.rate_limit_rpm ?? ''
  developmentTokenBudget.value = llm?.development?.token_budget ?? ''
  developmentCallBudget.value = llm?.development?.call_budget ?? ''
  developmentRateLimit.value = llm?.development?.rate_limit_rpm ?? ''
  saved.value = false
  error.value = null
}

watch(() => props.season.id, seedFromSeason, { immediate: true })

function addMatch(): void {
  matches.value.push({ slots: ['submission'], seedsText: '0', games: 1 })
}

function removeMatch(index: number): void {
  matches.value.splice(index, 1)
}

function addSlot(match: MatchDraft): void {
  match.slots.push('submission')
}

function removeSlot(match: MatchDraft, slotIndex: number): void {
  match.slots.splice(slotIndex, 1)
}

/** Parse a free-text seed list ("0, 1 2") into a de-duplicated list of integers. */
function parseSeeds(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => Number(token))
    .filter((value) => Number.isInteger(value))
}

function buildLimitOverride(
  label: string,
  tokenBudget: number | '',
  callBudget: number | '',
  rateLimit: number | '',
): { limits?: LlmLimitOverride; error?: string } {
  const values = [
    ['token budget', tokenBudget],
    ['call budget', callBudget],
    ['rate limit', rateLimit],
  ] as const
  for (const [name, value] of values) {
    if (value !== '' && (!Number.isInteger(Number(value)) || Number(value) < 1)) {
      return { error: `The ${label} ${name} must be a positive integer.` }
    }
  }
  const limits: LlmLimitOverride = {}
  if (tokenBudget !== '') limits.token_budget = Number(tokenBudget)
  if (callBudget !== '') limits.call_budget = Number(callBudget)
  if (rateLimit !== '') limits.rate_limit_rpm = Number(rateLimit)
  return Object.keys(limits).length === 0 ? {} : { limits }
}

/** Build the config document from the form, or return a client-side validation message. */
function buildConfig(): { config: SeasonConfig } | { error: string } {
  const built: MatchConfig[] = []
  for (let i = 0; i < matches.value.length; i++) {
    const match = matches.value[i]!
    if (match.slots.length === 0) {
      return { error: `Match ${i + 1} has no slots. Every match must assign at least one slot.` }
    }
    const seeds = parseSeeds(match.seedsText)
    if (seeds.length === 0) {
      return { error: `Match ${i + 1} needs at least one integer seed.` }
    }
    if (!Number.isInteger(match.games) || match.games < 1) {
      return { error: `Match ${i + 1} needs a game count of at least 1.` }
    }
    built.push({ slots: [...match.slots], seeds, games: match.games })
  }
  if (!Number.isInteger(depsVersion.value) || depsVersion.value < 1) {
    return { error: 'The dependency-set version must be a positive integer.' }
  }
  // Capability blocks stay absent when every field inherits its deployment or environment default.
  const overrides: NonNullable<SeasonConfig['overrides']> = {}
  if (stepTimeout.value !== '') overrides.step_timeout_ms = Number(stepTimeout.value)
  if (episodeTimeout.value !== '') overrides.episode_timeout_ms = Number(episodeTimeout.value)
  const messaging: NonNullable<SeasonOverrides['messaging']> = {}
  if (messagingEnabled.value !== 'default') messaging.enabled = messagingEnabled.value === 'on'
  if (messageCap.value !== '') messaging.message_cap = Number(messageCap.value)
  if (Object.keys(messaging).length > 0) overrides.messaging = messaging
  if (llmModelsMode.value === 'custom' && llmModels.value.length === 0) {
    return { error: 'Select at least one allowed LLM model alias, or inherit all deployment aliases.' }
  }
  const official = buildLimitOverride(
    'official',
    officialTokenBudget.value,
    officialCallBudget.value,
    officialRateLimit.value,
  )
  if (official.error !== undefined) return { error: official.error }
  const development = buildLimitOverride(
    'development',
    developmentTokenBudget.value,
    developmentCallBudget.value,
    developmentRateLimit.value,
  )
  if (development.error !== undefined) return { error: development.error }
  const llm: NonNullable<SeasonOverrides['llm']> = {}
  if (llmEnabled.value !== 'default') llm.enabled = llmEnabled.value === 'on'
  if (llmModelsMode.value === 'custom') {
    llm.models = LLM_MODEL_ALIASES.filter((alias) => llmModels.value.includes(alias))
  }
  if (official.limits !== undefined) llm.official = official.limits
  if (development.limits !== undefined) llm.development = development.limits
  if (Object.keys(llm).length > 0) overrides.llm = llm
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
  const overrides = config.overrides
  return JSON.stringify({
    deps_version: config.deps_version,
    matches: config.matches.map((m) => ({ slots: m.slots, seeds: m.seeds, games: m.games })),
    overrides:
      overrides === undefined
        ? null
        : {
            step_timeout_ms: overrides.step_timeout_ms ?? null,
            episode_timeout_ms: overrides.episode_timeout_ms ?? null,
            messaging: overrides.messaging ?? null,
            llm: canonicalLlm(overrides.llm),
          },
  })
}

/**
 * Normalize a stored LLM override to the exact key/alias order `buildConfig` emits. The backend
 * accepts any key order and any alias order, so a config saved by a script must not read as a
 * permanent unsaved edit (which would gate the Run button) just because it serialized differently.
 */
function canonicalLlm(llm: SeasonOverrides['llm']): Record<string, unknown> | null {
  if (llm === undefined) return null
  return {
    enabled: llm.enabled ?? null,
    models:
      llm.models === undefined
        ? null
        : LLM_MODEL_ALIASES.filter((alias) => llm.models?.includes(alias)),
    official: canonicalLimits(llm.official),
    development: canonicalLimits(llm.development),
  }
}

function canonicalLimits(limits: LlmLimitOverride | undefined): Record<string, unknown> | null {
  if (limits === undefined) return null
  return {
    token_budget: limits.token_budget ?? null,
    call_budget: limits.call_budget ?? null,
    rate_limit_rpm: limits.rate_limit_rpm ?? null,
  }
}

/**
 * Whether the form differs from the saved season config. An incomplete/invalid draft (e.g. a match
 * mid-edit with no seeds yet) counts as dirty: it still needs a save, and a run on it must be blocked.
 */
const dirty = computed(() => {
  const result = buildConfig()
  if ('error' in result) {
    return true
  }
  return canonicalConfig(result.config) !== canonicalConfig(props.season.config)
})

// Surface the dirty state to the console so it can gate "Run workflow" on a saved design.
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
    <h3 class="config-title">Match design</h3>

    <UiField label="Dependency-set version" hint="Defaults to the current template release.">
      <template #default="{ id }">
        <UiInput :id="id" v-model.number="depsVersion" type="number" min="1" />
      </template>
    </UiField>

    <ol class="match-list">
      <li v-for="(match, matchIndex) in matches" :key="matchIndex" class="match" data-testid="match">
        <div class="match-head">
          <span class="match-label">Match {{ matchIndex + 1 }}</span>
          <UiButton variant="ghost" size="tight" @click="removeMatch(matchIndex)">
            Remove match
          </UiButton>
        </div>

        <div class="slots">
          <span class="slots-label">Slots</span>
          <div
            v-for="(slot, slotIndex) in match.slots"
            :key="slotIndex"
            class="slot"
            data-testid="slot"
          >
            <select v-model="match.slots[slotIndex]" class="slot-select" aria-label="Slot seat">
              <option v-for="spec in SLOT_SPECS" :key="spec" :value="spec">{{ spec }}</option>
            </select>
            <UiButton variant="ghost" size="tight" @click="removeSlot(match, slotIndex)">×</UiButton>
          </div>
          <UiButton variant="secondary" size="tight" @click="addSlot(match)">Add slot</UiButton>
        </div>

        <div class="match-fields">
          <UiField label="Seeds" hint="Comma-separated integers.">
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
    <UiButton variant="secondary" size="tight" @click="addMatch">Add match</UiButton>

    <h3 class="config-title config-title--spaced">Overrides</h3>
    <h4 class="config-group-title">Session behavior</h4>
    <div class="match-fields">
      <UiField label="Step timeout (ms)" hint="Optional; falls back to the environment default.">
        <template #default="{ id }">
          <UiInput :id="id" v-model.number="stepTimeout" type="number" min="1" placeholder="default" />
        </template>
      </UiField>
      <UiField label="Episode timeout (ms)" hint="Optional; falls back to the environment default.">
        <template #default="{ id }">
          <UiInput
            :id="id"
            v-model.number="episodeTimeout"
            type="number"
            min="1"
            placeholder="default"
          />
        </template>
      </UiField>
      <UiField
        label="Messaging"
        hint="Default keeps the environment's setting; Off silences it. It can never enable an opted-out environment."
      >
        <template #default="{ id }">
          <UiSelect :id="id" v-model="messagingEnabled">
            <option value="default">Environment default</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </UiSelect>
        </template>
      </UiField>
      <UiField
        label="Message cap (code points)"
        hint="Optional; only tightens. The effective cap is the smaller of this and the environment's."
      >
        <template #default="{ id }">
          <UiInput :id="id" v-model.number="messageCap" type="number" min="1" placeholder="default" />
        </template>
      </UiField>
    </div>

    <section class="llm-config" aria-labelledby="llm-config-title">
      <h4 id="llm-config-title" class="config-group-title">LLM access</h4>
      <div class="match-fields">
        <UiField
          label="LLM enablement"
          hint="A season must explicitly enable LLM access. Default leaves the field unset."
        >
          <template #default="{ id }">
            <UiSelect :id="id" v-model="llmEnabled">
              <option value="default">Not set (disabled)</option>
              <option value="on">Enabled</option>
              <option value="off">Explicitly disabled</option>
            </UiSelect>
          </template>
        </UiField>
        <UiField
          label="Allowed model aliases"
          hint="Inherit every configured deployment alias, or choose a non-empty subset."
        >
          <template #default="{ id }">
            <UiSelect :id="id" v-model="llmModelsMode">
              <option value="all">All deployment aliases</option>
              <option value="custom">Custom selection</option>
            </UiSelect>
          </template>
        </UiField>
      </div>

      <fieldset v-if="llmModelsMode === 'custom'" class="alias-picker">
        <legend>Model aliases</legend>
        <label v-for="alias in LLM_MODEL_ALIASES" :key="alias" class="alias-option">
          <input v-model="llmModels" type="checkbox" :value="alias" />
          <span>{{ alias }}</span>
        </label>
      </fieldset>

      <div class="limit-groups">
        <fieldset class="limit-group">
          <legend>Official per-slot limits</legend>
          <UiField label="Official token budget" hint="Optional; inherits the deployment default.">
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
          <UiField label="Official call budget" hint="Optional; inherits the deployment default.">
            <template #default="{ id }">
              <UiInput
                :id="id"
                v-model.number="officialCallBudget"
                type="number"
                min="1"
                placeholder="default"
              />
            </template>
          </UiField>
          <UiField label="Official rate limit (RPM)" hint="Optional; inherits the deployment default.">
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
          <UiField label="Development token budget" hint="Optional; inherits the deployment default.">
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
          <UiField label="Development call budget" hint="Optional; inherits the deployment default.">
            <template #default="{ id }">
              <UiInput
                :id="id"
                v-model.number="developmentCallBudget"
                type="number"
                min="1"
                placeholder="default"
              />
            </template>
          </UiField>
          <UiField
            label="Development rate limit (RPM)"
            hint="Optional; inherits the deployment default."
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
    </section>

    <div class="config-actions">
      <UiButton :loading="saving" @click="save">Save configuration</UiButton>
      <span v-if="dirty" class="config-dirty" role="status">● Unsaved changes</span>
      <span v-else-if="saved" class="config-saved" role="status">Saved ✓</span>
      <span v-if="error" class="config-error" role="alert">{{ error }}</span>
    </div>

    <UiDialog v-model:open="confirmOpen" title="Confirm a destructive edit">
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
      <div class="confirm-actions">
        <UiButton variant="danger" :loading="saving" @click="confirmForce">
          Delete and save
        </UiButton>
        <UiButton variant="ghost" @click="confirmOpen = false">Cancel</UiButton>
      </div>
    </UiDialog>
  </div>
</template>

<style scoped>
.config-title {
  margin: 0 0 var(--space-3);
  font-size: var(--text-md);
}

.config-title--spaced {
  margin-top: var(--space-5);
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
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
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

.slots {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-bottom: var(--space-3);
}

.slots-label {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.slot {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.slot-select {
  font: inherit;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
}

.match-fields {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.config-group-title {
  margin: var(--space-4) 0 var(--space-3);
  font-size: var(--text-sm);
}

.llm-config {
  margin-top: var(--space-5);
}

.alias-picker,
.limit-group {
  margin: var(--space-4) 0 0;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.alias-picker legend,
.limit-group legend {
  padding: 0 var(--space-2);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: 600;
}

.alias-picker {
  display: flex;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.alias-option {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono);
}

.limit-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: var(--space-4);
}

.limit-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.config-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-4);
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

.config-error {
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.confirm-text {
  margin: 0 0 var(--space-4);
  color: var(--color-text);
}

.confirm-actions {
  display: flex;
  gap: var(--space-3);
}
</style>
