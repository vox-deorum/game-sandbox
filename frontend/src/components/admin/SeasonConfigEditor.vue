<!--
  The match-design config editor of the operator console (Stage 6.7). It edits the season's whole
  SeasonConfig: the match design (each match's slot composition of builtin-naive / submission seats,
  its seeds, and its game count), the deps_version (defaulted to the current release at declaration),
  and the override blocks. The per-step / per-episode timeout overrides are active this stage; the
  messaging and LLM fields are present but labeled as applying in Stages 8/9, and round-trip unchanged.

  Two guards, mirroring the step-3 contract:
  - A match with zero slots is never saved (the editor refuses it before the request).
  - A config edit once runs exist, or a deps_version change once submissions exist, is destructive. The
    first save attempt goes without `force`; the backend refuses it with a typed conflict, and the
    editor opens a confirmation dialog spelling out exactly what will be deleted before re-sending with
    `force`. Without that confirmation the edit does not happen. The environment slot-count errors come
    back as `invalid_config` and render inline.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import {
  configureSeason,
  type SeasonConfig,
  type SeasonView,
  type MatchConfig,
  type SlotSpec,
} from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiDialog from '../ui/UiDialog.vue'
import UiField from '../ui/UiField.vue'
import UiInput from '../ui/UiInput.vue'

const props = defineProps<{ season: SeasonView }>()
const emit = defineEmits<{
  (e: 'changed', season: SeasonView): void
  /** Whether the form holds match-design edits not yet persisted; drives the Run gate upstream. */
  (e: 'dirty-change', dirty: boolean): void
}>()

const SLOT_SPECS: SlotSpec[] = ['submission', 'builtin-naive']

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
  // Preserve the inert messaging/llm override blocks untouched; only the active timeouts are edited here.
  const overrides: NonNullable<SeasonConfig['overrides']> = {}
  if (stepTimeout.value !== '') overrides.step_timeout_ms = Number(stepTimeout.value)
  if (episodeTimeout.value !== '') overrides.episode_timeout_ms = Number(episodeTimeout.value)
  const existing = props.season.config.overrides
  if (existing?.messaging !== undefined) overrides.messaging = existing.messaging
  if (existing?.llm !== undefined) overrides.llm = existing.llm
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
            llm: overrides.llm ?? null,
          },
  })
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
    </div>
    <p class="config-note">Messaging and LLM overrides apply in Stage 8/9 and are preserved unchanged.</p>

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

.config-note {
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
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
