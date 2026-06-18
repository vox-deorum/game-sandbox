<!--
  The operator's iteration-wide rating prompt editor (Stage 6.7). Unlike the match-design config, this
  prompt stays editable at every point in the iteration's life — before or after runs and release — so
  it is its own small, always-available field rather than part of the force-confirmed config editor.

  The prompt is shown to human raters next to the 1-5 control for every agent in the iteration. It is
  distinct from each author's own per-agent prompt, which authors set on their agent profile.
-->
<script setup lang="ts">
import { ref, watch } from 'vue'

import { type IterationView, setIterationRatingPrompt } from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiCard from '../ui/UiCard.vue'
import UiField from '../ui/UiField.vue'

const props = defineProps<{ iteration: IterationView }>()
const emit = defineEmits<{ (e: 'changed', iteration: IterationView): void }>()

const draft = ref(props.iteration.rating_prompt ?? '')
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

// Re-seed when the selected iteration changes under us (the console switches between iterations).
watch(
  () => props.iteration.id,
  () => {
    draft.value = props.iteration.rating_prompt ?? ''
    saved.value = false
    error.value = null
  },
)

async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  error.value = null
  const trimmed = draft.value.trim()
  const result = await setIterationRatingPrompt(props.iteration.id, trimmed === '' ? null : trimmed)
  saving.value = false
  if (result.ok) {
    saved.value = true
    emit('changed', result.iteration)
    return
  }
  error.value =
    result.reason === 'too_long'
      ? 'That prompt is too long.'
      : 'Could not save the rating prompt. Please try again.'
}
</script>

<template>
  <UiCard class="prompt">
    <h3 class="prompt-title">Iteration rating prompt</h3>
    <p class="prompt-sub">
      Shown to human raters for every agent in this iteration. Editable at any time, including after a
      run or release. Separate from each author's own per-agent prompt.
    </p>
    <UiField label="Rating prompt" hint="Leave empty to clear it.">
      <template #default="{ id, describedby }">
        <textarea
          :id="id"
          v-model="draft"
          class="prompt-input"
          rows="3"
          maxlength="2000"
          :aria-describedby="describedby"
        />
      </template>
    </UiField>
    <div class="prompt-actions">
      <UiButton :loading="saving" @click="save">Save prompt</UiButton>
      <span v-if="saved" class="prompt-saved" role="status">Saved ✓</span>
      <span v-if="error" class="prompt-error" role="alert">{{ error }}</span>
    </div>
  </UiCard>
</template>

<style scoped>
.prompt-title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-md);
}

.prompt-sub {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.prompt-input {
  font: inherit;
  width: 100%;
  resize: vertical;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
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

.prompt-error {
  font-size: var(--text-sm);
  color: var(--color-danger);
}
</style>
