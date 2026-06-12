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
