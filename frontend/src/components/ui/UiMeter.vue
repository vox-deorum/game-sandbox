<script setup lang="ts">
defineProps<{
  value: number
  max: number
  /** Visible value text. Color and bar length never carry the value alone. */
  textValue: string
  /** Accessible name for the native meter. */
  label: string
}>()
</script>

<template>
  <div class="ui-meter">
    <meter
      class="track"
      role="meter"
      :value="value"
      :max="max"
      :aria-label="label"
      :aria-valuemin="0"
      :aria-valuenow="value"
      :aria-valuemax="max"
      :aria-valuetext="textValue"
    />
    <span class="value">{{ textValue }}</span>
  </div>
</template>

<style scoped>
.ui-meter {
  display: grid;
  gap: var(--space-1);
}

.track {
  width: 100%;
  height: var(--space-3);
  border: 0;
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
}

.track::-webkit-meter-bar {
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
}

.track::-webkit-meter-optimum-value,
.track::-moz-meter-bar {
  background: var(--color-accent);
  border-radius: var(--radius-full);
}

.value {
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
