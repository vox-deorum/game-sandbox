<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import type { SeasonView } from '../../api/client.js'
import { useLatestRequest } from '../../composables/useLatestRequest.js'
import UiButton from '../ui/UiButton.vue'
import UiField from '../ui/UiField.vue'
import UiInput from '../ui/UiInput.vue'
import UiTextarea from '../ui/UiTextarea.vue'

type SeasonTextField = 'rating_prompt' | 'description_markdown'
type PersistResult =
  | { ok: true; season: SeasonView }
  | { ok: false; reason: string }
type TemplateRepositoryPersistResult =
  | { ok: true; season: SeasonView }
  | { ok: false; reason: string }

const props = withDefaults(
  defineProps<{
    season: SeasonView
    field: SeasonTextField
    label: string
    saveLabel: string
    maxLength: number
    persist: (seasonId: string, value: string | null) => Promise<PersistResult>
    errorMessage: (reason: string) => string
    clearable?: boolean
    savedLabel?: string
    clearLabel?: string
    templateRepository?: string | null
    persistTemplateRepository?: (
      seasonId: string,
      templateRepositoryUrl: string | null,
    ) => Promise<TemplateRepositoryPersistResult>
    templateRepositoryErrorMessage?: (reason: string) => string
  }>(),
  { clearable: false, savedLabel: 'Saved', clearLabel: 'Clear' },
)
const emit = defineEmits<{ (e: 'changed', season: SeasonView): void }>()

const draft = ref(props.season[props.field] ?? '')
const saving = ref(false)
const saved = ref<string | null>(null)
const error = ref<string | null>(null)
const saveRequest = useLatestRequest()
const templateRepository = ref(props.templateRepository ?? '')
const templateSaving = ref(false)
const templateSaved = ref<string | null>(null)
const templateError = ref<string | null>(null)
const templateRequest = useLatestRequest()

onBeforeUnmount(() => {
  saveRequest.invalidate()
  templateRequest.invalidate()
})

watch(
  () => props.season.id,
  () => {
    saveRequest.invalidate()
    templateRequest.invalidate()
    draft.value = props.season[props.field] ?? ''
    saving.value = false
    saved.value = null
    error.value = null
    templateRepository.value = props.templateRepository ?? ''
    templateSaving.value = false
    templateSaved.value = null
    templateError.value = null
  },
)

async function persist(value: string | null, success: string): Promise<void> {
  const seasonId = props.season.id
  const isCurrent = saveRequest.begin()
  saving.value = true
  saved.value = null
  error.value = null
  try {
    const result = await props.persist(seasonId, value)
    if (!isCurrent() || props.season.id !== seasonId) return
    if (result.ok) {
      draft.value = result.season[props.field] ?? ''
      saved.value = success
      emit('changed', result.season)
      return
    }
    error.value = props.errorMessage(result.reason)
  } catch {
    if (isCurrent() && props.season.id === seasonId) {
      error.value = props.errorMessage('failed')
    }
  } finally {
    if (isCurrent() && props.season.id === seasonId) {
      saving.value = false
    }
  }
}

async function saveTemplateRepository(): Promise<void> {
  const persistTemplateRepository = props.persistTemplateRepository
  if (persistTemplateRepository === undefined) return
  const seasonId = props.season.id
  const isCurrent = templateRequest.begin()
  templateSaving.value = true
  templateSaved.value = null
  templateError.value = null
  try {
    const value = templateRepository.value.trim()
    const result = await persistTemplateRepository(seasonId, value === '' ? null : value)
    if (!isCurrent() || props.season.id !== seasonId) return
    if (result.ok) {
      templateRepository.value = result.season.template_repo_url ?? ''
      templateSaved.value = 'Saved'
      emit('changed', result.season)
      return
    }
    templateError.value =
      props.templateRepositoryErrorMessage?.(result.reason) ??
      'Could not save the template repository.'
  } catch {
    if (isCurrent() && props.season.id === seasonId) {
      templateError.value =
        props.templateRepositoryErrorMessage?.('failed') ??
        'Could not save the template repository.'
    }
  } finally {
    if (isCurrent() && props.season.id === seasonId) {
      templateSaving.value = false
    }
  }
}

function save(): Promise<void> {
  const value = draft.value.trim()
  return persist(value === '' ? null : value, props.savedLabel)
}

function clear(): Promise<void> {
  return persist(null, 'Cleared')
}
</script>

<template>
  <div class="operator-season-text-editor" :class="{ 'is-clearable': clearable }">
    <slot />
    <UiField :label="label" :error="error ?? undefined">
      <template #default="{ id, describedby, invalid }">
        <UiTextarea
          :id="id"
          v-model="draft"
          rows="3"
          :maxlength="maxLength"
          :aria-describedby="describedby"
          :invalid="invalid"
          :disabled="saving"
        />
      </template>
    </UiField>
    <div class="operator-season-text-editor-actions" :class="{ 'is-clearable': clearable }">
      <UiButton :loading="saving" @click="save">{{ saveLabel }}</UiButton>
      <UiButton v-if="clearable" variant="secondary" :disabled="saving" @click="clear">
        {{ props.clearLabel }}
      </UiButton>
      <span v-if="saved" class="operator-season-text-editor-saved" role="status">{{ saved }}</span>
    </div>
    <div v-if="persistTemplateRepository !== undefined" class="template-repository">
      <UiField
        label="Template repository"
        hint="Leave blank to use the published template branch for this environment."
        :error="templateError ?? undefined"
      >
        <template #default="{ id, describedby, invalid }">
          <UiInput
            :id="id"
            v-model="templateRepository"
            type="url"
            placeholder="https://github.com/your-org/agent-template"
            :aria-describedby="describedby"
            :invalid="invalid"
            :disabled="templateSaving"
          />
        </template>
      </UiField>
      <div class="operator-season-text-editor-actions">
        <UiButton :loading="templateSaving" @click="saveTemplateRepository">
          Save template repository
        </UiButton>
        <span v-if="templateSaved" class="operator-season-text-editor-saved" role="status">
          {{ templateSaved }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.operator-season-text-editor.is-clearable {
  margin: var(--space-4) 0 0;
  padding: var(--space-4) 0 0;
  border-top: 1px solid var(--color-border);
}

:slotted(p) {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.operator-season-text-editor-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.operator-season-text-editor-actions.is-clearable {
  flex-wrap: wrap;
}

.template-repository {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.operator-season-text-editor-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}
</style>
