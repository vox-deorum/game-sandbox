<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed } from 'vue'

import type { SeasonSettings } from '../api/client.js'
import { describeSeasonChanges } from '../lib/season-settings.js'

const props = defineProps<{
  meta: EnvironmentMeta
  settings: SeasonSettings
}>()

const changes = computed(() => describeSeasonChanges(props.meta, props.settings))
</script>

<template>
  <ul
    v-if="changes.length > 0"
    class="season-changes"
    aria-label="Season changes"
  >
    <li v-for="change in changes" :key="change.label">
      <span class="season-change-context">{{ change.label }} {{ change.from }} → </span>
      <span>{{ change.to }}</span>
    </li>
  </ul>
  <p v-else class="season-changes-empty">This season uses the default settings.</p>
</template>

<style scoped>
.season-changes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--space-2) var(--space-5);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}

.season-change-context {
  color: var(--color-text-muted);
}

.season-changes-empty {
  margin: var(--space-3) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
</style>
