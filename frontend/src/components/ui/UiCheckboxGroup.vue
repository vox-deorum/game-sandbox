<script setup lang="ts">
import { computed, useId } from 'vue'

const props = defineProps<{
  legend: string
  options: readonly { value: string; label: string }[]
  hint?: string
  error?: string
  disabled?: boolean
}>()
const model = defineModel<string[]>({ required: true })
const id = useId()
const hintId = `${id}-hint`
const errorId = `${id}-error`
const describedby = computed(() => {
  const ids = [props.hint ? hintId : null, props.error ? errorId : null].filter(Boolean)
  return ids.length === 0 ? undefined : ids.join(' ')
})

function toggle(value: string, checked: boolean): void {
  const selected = new Set(model.value)
  if (checked) selected.add(value)
  else selected.delete(value)
  model.value = props.options.map((option) => option.value).filter((option) => selected.has(option))
}
</script>

<template>
  <fieldset
    class="ui-checkbox-group"
    :disabled="disabled"
    :aria-describedby="describedby"
    :aria-invalid="error ? true : undefined"
  >
    <legend>{{ legend }}</legend>
    <label v-for="option in options" :key="option.value" class="ui-checkbox-option">
      <input
        type="checkbox"
        :checked="model.includes(option.value)"
        @change="toggle(option.value, ($event.target as HTMLInputElement).checked)"
      />
      <span>{{ option.label }}</span>
    </label>
    <p v-if="hint" :id="hintId" class="ui-checkbox-hint">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="ui-checkbox-error" role="alert">{{ error }}</p>
  </fieldset>
</template>

<style scoped>
.ui-checkbox-group { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.ui-checkbox-group legend { padding: 0; font-size: var(--text-sm); color: var(--color-text-muted); }
.ui-checkbox-option { display: flex; align-items: center; gap: var(--space-2); color: var(--color-text); cursor: pointer; }
.ui-checkbox-option input { accent-color: var(--color-accent); }
.ui-checkbox-hint, .ui-checkbox-error { margin: 0; font-size: var(--text-xs); }
.ui-checkbox-hint { color: var(--color-text-muted); }
.ui-checkbox-error { color: var(--color-danger); }
</style>
