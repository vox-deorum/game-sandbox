<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed } from 'vue'

import type { ResolvedSeasonSettings } from '../api/client.js'
import { formatSeasonName } from '../lib/format.js'
import { describeSeasonChanges } from '../lib/season-settings.js'

const props = defineProps<{
  meta: EnvironmentMeta
  settings: ResolvedSeasonSettings
  /** The section this summary sits in, as it reads in the group label: "play season", "season". */
  context: string
  /** The season these settings resolve to, named after the context in the same label. */
  season: { id: string; label: string | null }
}>()

const changes = computed(() => describeSeasonChanges(props.meta, props.settings))
// Several summaries can share a page, so the group names the season it describes. The list inside
// inherits that name from the group and stays unlabelled, which keeps the announcement to one pass.
const groupLabel = computed(() => `Settings for ${props.context} ${formatSeasonName(props.season)}`)
</script>

<template>
  <div class="season-settings" role="group" :aria-label="groupLabel">
    <span class="season-settings-label">Settings:</span>
    <ul v-if="changes.length > 0" class="season-changes">
      <li v-for="change in changes" :key="change.label">
        <span class="season-change-visual" aria-hidden="true">
          <span class="season-change-label">{{ change.label }}</span>
          <span class="season-change-values">{{ change.from }} → {{ change.to }}</span>
        </span>
        <span class="sr-only">{{ change.label }} from {{ change.from }} to {{ change.to }}</span>
      </li>
    </ul>
    <p v-else class="season-changes-empty">This season uses the default settings.</p>
  </div>
</template>

<style scoped>
.season-settings {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  font-size: var(--text-sm);
}

.season-settings-label {
  font-weight: 600;
}

.season-changes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.season-changes li {
  display: inline-flex;
}

.season-change-visual {
  display: inline-flex;
  flex-wrap: wrap;
  column-gap: var(--space-1);
}

.season-changes li:not(:last-child)::after {
  content: '·';
  margin-left: var(--space-2);
  color: var(--color-text-muted);
}

.season-change-label {
  font-weight: 500;
}

.season-change-values {
  color: var(--color-text-muted);
  white-space: nowrap;
}

.season-changes-empty {
  margin: 0;
  color: var(--color-text-muted);
}

@media (max-width: 480px) {
  .season-settings,
  .season-changes {
    display: grid;
    gap: var(--space-2);
  }

  .season-changes li:not(:last-child)::after {
    content: none;
  }
}
</style>
