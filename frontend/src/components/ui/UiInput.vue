<!--
  The text input primitive. Pair it with UiField, spreading the slot's `id` and `describedby` onto
  it. Non-prop attributes (type, min, max, placeholder, aria-*) fall through to the input element.
-->
<script setup lang="ts">
const model = defineModel<string>({ required: true })

withDefaults(defineProps<{ invalid?: boolean }>(), { invalid: false })
</script>

<template>
  <input v-model="model" class="ui-input" :class="{ invalid }" :aria-invalid="invalid || undefined" />
</template>

<style scoped>
.ui-input {
  font: inherit;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  transition: border-color var(--motion-fast) var(--ease-out);
}

.ui-input:hover {
  border-color: var(--color-border-strong);
}

.ui-input.invalid {
  border-color: var(--color-danger);
}

.ui-input:disabled {
  opacity: 0.6;
}
</style>
