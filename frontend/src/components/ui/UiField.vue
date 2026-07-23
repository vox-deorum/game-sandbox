<!--
  The form field primitive: a label, the control, and optional hint and error text, with the ARIA
  wiring done once. The control renders through the scoped slot, which receives the generated `id`
  and `describedby` to spread onto the input, so label and description association is automatic.
-->
<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{
  label: string
  hint?: string
  /** Validation message; when set the field shows it and marks the control invalid. */
  error?: string
}>()

const id = useId()
const hintId = `${id}-hint`
const errorId = `${id}-error`

// Only ids of elements actually rendered, so aria-describedby never dangles.
const describedby = computed(() => {
  const ids: string[] = []
  if (props.hint) ids.push(hintId)
  if (props.error) ids.push(errorId)
  return ids.length > 0 ? ids.join(' ') : undefined
})
</script>

<template>
  <div class="ui-field">
    <label class="ui-field-label" :for="id">{{ label }}</label>
    <slot :id="id" :describedby="describedby" :invalid="error !== undefined" />
    <p v-if="hint" :id="hintId" class="ui-field-hint">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="ui-field-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.ui-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ui-field-label {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.ui-field-hint {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.ui-field-error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-danger);
}
</style>
