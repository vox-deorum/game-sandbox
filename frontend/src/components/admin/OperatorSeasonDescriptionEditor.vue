<!-- The operator's always-editable short public season description. -->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import { SEASON_DESCRIPTION_MAX } from '@game-sandbox/schema/seasons'

import { type SeasonView, setSeasonDescription } from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiField from '../ui/UiField.vue'
import UiTextarea from '../ui/UiTextarea.vue'

const props = defineProps<{ season: SeasonView }>()
const emit = defineEmits<{ (e: 'changed', season: SeasonView): void }>()

const draft = ref(props.season.description_markdown ?? '')
const saving = ref(false)
const saved = ref<string | null>(null)
const error = ref<string | null>(null)
// Invalidates pending saves when this editor is reused for a different selected season.
let saveRequest = 0

onBeforeUnmount(() => {
  saveRequest += 1
})

watch(
  () => props.season.id,
  () => {
    saveRequest += 1
    draft.value = props.season.description_markdown ?? ''
    saving.value = false
    saved.value = null
    error.value = null
  },
)

async function persist(markdown: string | null, success: string): Promise<void> {
  const seasonId = props.season.id
  const request = ++saveRequest
  saving.value = true
  saved.value = null
  error.value = null
  try {
    const result = await setSeasonDescription(seasonId, markdown)
    if (request !== saveRequest || props.season.id !== seasonId) return
    if (result.ok) {
      draft.value = result.season.description_markdown ?? ''
      saved.value = success
      emit('changed', result.season)
      return
    }
    error.value =
      result.reason === 'too_long'
        ? 'That description is too long.'
        : result.reason === 'multiple_paragraphs'
          ? 'Use one paragraph only.'
          : 'Could not save the season description. Please try again.'
  } catch {
    if (request === saveRequest && props.season.id === seasonId) {
      error.value = 'Could not save the season description. Please try again.'
    }
  } finally {
    if (request === saveRequest && props.season.id === seasonId) {
      saving.value = false
    }
  }
}

function save(): Promise<void> {
  const markdown = draft.value.trim()
  return persist(markdown === '' ? null : markdown, 'Saved')
}

function clear(): Promise<void> {
  return persist(null, 'Cleared')
}
</script>

<template>
  <div class="description-editor">
    <p class="description-sub">
      Shown on public Season cards. After line-ending normalization, use up to
      {{ SEASON_DESCRIPTION_MAX.toLocaleString() }} characters in one paragraph. Inline Markdown
      supports emphasis, strong text, inline code, and HTTP or HTTPS links.
    </p>
    <UiField label="Season description" :error="error ?? undefined">
      <template #default="{ id, describedby, invalid }">
        <UiTextarea
          :id="id"
          v-model="draft"
          rows="3"
          :maxlength="SEASON_DESCRIPTION_MAX"
          :aria-describedby="describedby"
          :invalid="invalid"
          :disabled="saving"
        />
      </template>
    </UiField>
    <div class="description-actions">
      <UiButton :loading="saving" @click="save">Save description</UiButton>
      <UiButton variant="secondary" :disabled="saving" @click="clear">Clear description</UiButton>
      <span v-if="saved" class="description-saved" role="status">{{ saved }}</span>
    </div>
  </div>
</template>

<style scoped>
.description-editor {
  padding: var(--space-4) 0;
  border-top: 1px solid var(--color-border);
}

.description-sub {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.description-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.description-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}
</style>
