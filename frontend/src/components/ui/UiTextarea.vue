<!--
  The multiline text input primitive. Pair it with UiField, spreading the slot's `id` and
  `describedby` onto it. Non-prop attributes (rows, maxlength, placeholder, aria-*, disabled) fall
  through to the textarea element.
-->
<script setup lang="ts">
const model = defineModel<string>({ required: true })

withDefaults(defineProps<{ invalid?: boolean }>(), { invalid: false })
</script>

<template>
  <textarea v-model="model" class="ui-textarea" :class="{ invalid }" :aria-invalid="invalid || undefined" />
</template>

<style scoped>
.ui-textarea {
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

.ui-textarea:hover {
  border-color: var(--color-border-strong);
}

.ui-textarea.invalid {
  border-color: var(--color-danger);
}

.ui-textarea:disabled {
  opacity: 0.6;
}
</style>
