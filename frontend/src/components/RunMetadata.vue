<script setup lang="ts">
// Shared display for run facts that can appear on both replay and terminal session screens.
export interface RunMetadataItem {
  label: string
  value: string | number | null | undefined
  code?: boolean
}

defineProps<{ items: RunMetadataItem[] }>()
</script>

<template>
  <dl class="run-metadata">
    <template v-for="item in items" :key="item.label">
      <template v-if="item.value !== null && item.value !== undefined && item.value !== ''">
        <dt>{{ item.label }}</dt>
        <dd>
          <code v-if="item.code">{{ item.value }}</code>
          <template v-else>{{ item.value }}</template>
        </dd>
      </template>
    </template>
  </dl>
</template>

<style scoped>
.run-metadata {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: var(--space-1) var(--space-4);
  margin: 0 0 var(--space-4);
  color: var(--color-text);
  font-size: var(--text-sm);
}

.run-metadata dt {
  color: var(--color-text-muted);
}

.run-metadata dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.run-metadata code {
  font-family: var(--font-mono);
}
</style>
