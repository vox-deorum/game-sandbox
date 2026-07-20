<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { LlmDevelopmentCredential } from '../api/client.js'
import UiButton from './ui/UiButton.vue'
import UiDialog from './ui/UiDialog.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'

const props = defineProps<{ credential: LlmDevelopmentCredential | null }>()
const emit = defineEmits<{ cleared: [] }>()
const open = defineModel<boolean>('open', { required: true })
const copyMessage = ref('')

const envText = computed(() =>
  props.credential
    ? `OPENAI_BASE_URL=${props.credential.base_url}\nOPENAI_API_KEY=${props.credential.api_key}`
    : '',
)

watch(open, (isOpen) => {
  copyMessage.value = ''
  if (!isOpen) emit('cleared')
})

async function copy(value: string, label: string): Promise<void> {
  copyMessage.value = ''
  try {
    await navigator.clipboard.writeText(value)
    copyMessage.value = `${label} copied.`
  } catch {
    copyMessage.value = `${label} could not be copied.`
  }
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    title="Development credential"
    description="Save this credential now. The secret is shown only once."
  >
    <div v-if="credential" class="credential-fields">
      <UiField label="OPENAI_BASE_URL">
        <template #default="{ id }">
          <span class="field-row">
            <UiInput
              :id="id"
              class="credential-input"
              :model-value="credential.base_url"
              readonly
            />
            <UiButton
              aria-label="Copy OPENAI_BASE_URL"
              variant="secondary"
              size="tight"
              @click="copy(credential.base_url, 'OPENAI_BASE_URL')"
            >
              Copy
            </UiButton>
          </span>
        </template>
      </UiField>
      <UiField label="OPENAI_API_KEY">
        <template #default="{ id }">
          <span class="field-row">
            <UiInput
              :id="id"
              class="credential-input"
              :model-value="credential.api_key"
              readonly
            />
            <UiButton
              aria-label="Copy OPENAI_API_KEY"
              variant="secondary"
              size="tight"
              @click="copy(credential.api_key, 'OPENAI_API_KEY')"
            >
              Copy
            </UiButton>
          </span>
        </template>
      </UiField>
      <p v-if="copyMessage" class="copy-status" role="status">{{ copyMessage }}</p>
      <div class="actions">
        <UiButton variant="secondary" @click="copy(envText, '.env')">Copy .env</UiButton>
        <UiButton @click="open = false">Done</UiButton>
      </div>
    </div>
  </UiDialog>
</template>

<style scoped>
.credential-fields {
  display: grid;
  gap: var(--space-4);
}

.field-row,
.actions {
  display: flex;
  gap: var(--space-2);
}

.credential-input {
  min-width: 0;
  flex: 1;
  font-family: var(--font-mono);
}

.actions {
  justify-content: flex-end;
  flex-wrap: wrap;
}

.copy-status {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
</style>
