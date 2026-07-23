<!--
  The operator's season-wide rating prompt editor (Stage 6.7). Unlike the match-design config, this
  prompt stays editable at every point in the season's life — before or after runs and release — so
  it is its own small, always-available field rather than part of the force-confirmed config editor.

  The prompt is shown to human raters next to the 1-5 control for every agent in the season. It is
  distinct from each author's own per-agent prompt, which authors set on their agent profile.
-->
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import { RATING_PROMPT_MAX } from '@game-sandbox/schema/seasons'

import { type SeasonView, setSeasonRatingPrompt } from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiField from '../ui/UiField.vue'
import UiTextarea from '../ui/UiTextarea.vue'

const props = defineProps<{ season: SeasonView }>()
const emit = defineEmits<{ (e: 'changed', season: SeasonView): void }>()

const draft = ref(props.season.rating_prompt ?? '')
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
// Invalidates pending saves when this editor is reused for a different selected season.
let saveRequest = 0

onBeforeUnmount(() => {
  saveRequest += 1
})

// Re-seed when the selected season changes under us (the console switches between seasons).
watch(
  () => props.season.id,
  () => {
    saveRequest += 1
    draft.value = props.season.rating_prompt ?? ''
    saving.value = false
    saved.value = false
    error.value = null
  },
)

async function save(): Promise<void> {
  const seasonId = props.season.id
  const request = ++saveRequest
  saving.value = true
  saved.value = false
  error.value = null
  const trimmed = draft.value.trim()
  try {
    const result = await setSeasonRatingPrompt(seasonId, trimmed === '' ? null : trimmed)
    if (request !== saveRequest || props.season.id !== seasonId) return
    if (result.ok) {
      draft.value = result.season.rating_prompt ?? ''
      saved.value = true
      emit('changed', result.season)
      return
    }
    error.value =
      result.reason === 'too_long'
        ? 'That prompt is too long.'
        : 'Could not save the rating prompt. Please try again.'
  } catch {
    if (request === saveRequest && props.season.id === seasonId) {
      error.value = 'Could not save the rating prompt. Please try again.'
    }
  } finally {
    if (request === saveRequest && props.season.id === seasonId) {
      saving.value = false
    }
  }
}
</script>

<template>
  <div class="prompt">
    <p class="prompt-sub">
      Shown to human raters for every agent in this season. Each author can have their own prompt.
    </p>
    <UiField label="Rating prompt" :error="error ?? undefined">
      <template #default="{ id, describedby, invalid }">
        <UiTextarea
          :id="id"
          v-model="draft"
          rows="3"
          :maxlength="RATING_PROMPT_MAX"
          :aria-describedby="describedby"
          :invalid="invalid"
          :disabled="saving"
        />
      </template>
    </UiField>
    <div class="prompt-actions">
      <UiButton :loading="saving" @click="save">Save prompt</UiButton>
      <span v-if="saved" class="prompt-saved" role="status">Saved ✓</span>
    </div>
  </div>
</template>

<style scoped>
.prompt-sub {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.prompt-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.prompt-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}

</style>
