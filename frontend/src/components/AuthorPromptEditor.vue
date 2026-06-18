<!--
  The agent author's rating-prompt editor (Stage 6.6), shown on the agent profile to the owner only.
  It answers "what should people evaluate about my agent?" — plain presentation guidance shown to
  raters next to the 1-5 control, kept distinct from the submission's validated artifact and status.

  Its parent chooses the applicable active submission, preferring the play-open iteration and then
  the submission-open iteration. The get/set routes resolve and authorize the caller server-side.
  Saving an empty prompt clears it. The editor reflects the saved value on reopening.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { getAuthorPrompt, setAuthorPrompt } from '../api/client.js'
import UiButton from './ui/UiButton.vue'
import UiCard from './ui/UiCard.vue'
import UiField from './ui/UiField.vue'

const props = defineProps<{ iterationId: string }>()

const draft = ref('')
// The last saved value, so the Save button can tell a real edit from a no-op.
const savedValue = ref('')
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    const current = await getAuthorPrompt(props.iterationId)
    draft.value = current.prompt ?? ''
    savedValue.value = current.prompt ?? ''
  } catch {
    error.value = 'Could not load your rating prompt.'
  } finally {
    loading.value = false
  }
})

const dirty = computed(() => draft.value.trim() !== savedValue.value.trim())

async function save(): Promise<void> {
  saving.value = true
  error.value = null
  saved.value = false
  const trimmed = draft.value.trim()
  const result = await setAuthorPrompt(props.iterationId, trimmed === '' ? null : trimmed)
  saving.value = false
  if (result.ok) {
    savedValue.value = result.prompt ?? ''
    draft.value = result.prompt ?? ''
    saved.value = true
    return
  }
  error.value = errorMessage(result.reason)
}

function errorMessage(reason: 'no_agent_in_iteration' | 'too_long' | 'failed'): string {
  switch (reason) {
    case 'no_agent_in_iteration':
      return 'You have no agent in the current round, so there is nothing to add a prompt to.'
    case 'too_long':
      return 'That prompt is too long.'
    default:
      return 'Could not save your rating prompt. Please try again.'
  }
}
</script>

<template>
  <UiCard class="prompt-editor">
    <h3 class="prompt-editor-title">Your rating prompt</h3>
    <p class="prompt-editor-sub">
      Tell raters what to evaluate about your agent. Shown next to the 1-5 control after a session.
    </p>

    <p v-if="loading" class="prompt-editor-loading">Loading…</p>
    <UiField v-else label="Rating prompt" hint="Leave empty to clear it.">
      <template #default="{ id, describedby }">
        <textarea
          :id="id"
          v-model="draft"
          class="prompt-editor-input"
          rows="3"
          maxlength="2000"
          :aria-describedby="describedby"
        />
      </template>
    </UiField>

    <div class="prompt-editor-actions">
      <UiButton :loading="saving" :disabled="loading || !dirty" @click="save">Save prompt</UiButton>
      <span v-if="saved" class="prompt-editor-saved" role="status">Saved ✓</span>
      <span v-if="error" class="prompt-editor-error" role="alert">{{ error }}</span>
    </div>
  </UiCard>
</template>

<style scoped>
.prompt-editor {
  margin-top: var(--space-6);
}

.prompt-editor-title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-md);
}

.prompt-editor-sub {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.prompt-editor-loading {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.prompt-editor-input {
  font: inherit;
  width: 100%;
  resize: vertical;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  transition: border-color var(--motion-fast) var(--ease-out);
}

.prompt-editor-input:hover {
  border-color: var(--color-border-strong);
}

.prompt-editor-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.prompt-editor-saved {
  font-size: var(--text-sm);
  color: var(--color-success);
}

.prompt-editor-error {
  font-size: var(--text-sm);
  color: var(--color-danger);
}
</style>
