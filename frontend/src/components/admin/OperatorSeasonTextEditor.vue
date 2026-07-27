<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import type { SeasonView } from '../../api/client.js'
import { useLatestRequest } from '../../composables/useLatestRequest.js'
import UiButton from '../ui/UiButton.vue'
import UiField from '../ui/UiField.vue'
import UiTextarea from '../ui/UiTextarea.vue'

type SeasonTextField = 'rating_prompt' | 'description_markdown'
type PersistResult =
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
  }>(),
  { clearable: false, savedLabel: 'Saved', clearLabel: 'Clear' },
)
const emit = defineEmits<{ (e: 'changed', season: SeasonView): void }>()

const draft = ref(props.season[props.field] ?? '')
const saving = ref(false)
const saved = ref<string | null>(null)
const error = ref<string | null>(null)
const saveRequest = useLatestRequest()

onBeforeUnmount(() => {
  saveRequest.invalidate()
})

watch(
  () => props.season.id,
  () => {
    saveRequest.invalidate()
    draft.value = props.season[props.field] ?? ''
    saving.value = false
    saved.value = null
    error.value = null
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

.operator-season-text-editor-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}
</style>
