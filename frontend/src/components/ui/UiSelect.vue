<!--
  The dropdown primitive: a native <select> styled to match UiInput. Pair it with UiField, spreading
  the slot's `id` and `describedby` onto it. Options render through the default slot as plain <option>
  elements, so the caller owns the value/label of each. Non-prop attributes (aria-*, disabled) fall
  through to the select element.
-->
<script setup lang="ts">
// A select's value is always a string, so this model is a string, unlike UiInput's string | number.
const model = defineModel<string>({ required: true })

withDefaults(defineProps<{ invalid?: boolean }>(), { invalid: false })
</script>

<template>
  <select
    v-model="model"
    class="ui-select"
    :class="{ invalid }"
    :aria-invalid="invalid || undefined"
  >
    <slot />
  </select>
</template>

<style scoped>
.ui-select {
  font: inherit;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  transition: border-color var(--motion-fast) var(--ease-out);
  cursor: pointer;
}

.ui-select:hover {
  border-color: var(--color-border-strong);
}

.ui-select.invalid {
  border-color: var(--color-danger);
}

.ui-select:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
