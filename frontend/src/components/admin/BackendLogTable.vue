<!--
  The current backend process log. This is deliberately separate from RunLogTable: process entries
  have stable sequence numbers, ISO timestamps, and subsystem names, while run logs belong to one
  container stream. The page owns polling and retention state; this component only renders it.
-->
<script setup lang="ts">
import { ref, watch } from 'vue'

import type { BackendLogEntry, BackendLogLevel } from '../../api/client.js'
import { formatLogTime } from '../../lib/format.js'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

const props = defineProps<{
  entries: BackendLogEntry[]
  /** Keep the tail in view only while the page is following live updates. */
  follow: boolean
}>()

const LEVEL_TONE: Record<BackendLogLevel, 'neutral' | 'warning' | 'danger'> = {
  info: 'neutral',
  warn: 'warning',
  error: 'danger',
}

const scroller = ref<HTMLElement | null>(null)

watch(
  // Retention can replace the oldest row with a newer one while the row count stays unchanged.
  () => [props.entries.length, props.entries.at(-1)?.seq, props.follow] as const,
  () => {
    if (!props.follow) {
      return
    }
    const element = scroller.value
    if (element !== null) {
      element.scrollTop = element.scrollHeight
    }
  },
  { flush: 'post' },
)
</script>

<template>
  <div ref="scroller" class="backend-log">
    <table>
      <thead>
        <tr>
          <th class="time-col" scope="col">Time</th>
          <th class="level-col" scope="col">Level</th>
          <th class="source-col" scope="col">Source</th>
          <th scope="col">Message</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.seq">
          <td class="time-col">{{ formatLogTime(Date.parse(entry.time)) }}</td>
          <td class="level-col"><UiStatusBadge :label="entry.level" :tone="LEVEL_TONE[entry.level]" /></td>
          <td class="source-col">{{ entry.source }}</td>
          <td class="message-col">{{ entry.message }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="entries.length === 0" class="backend-log-empty">No log entries match.</p>
  </div>
</template>

<style scoped>
.backend-log {
  max-height: 32rem;
  overflow: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

table {
  width: 100%;
  min-width: 48rem;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-weight: 600;
}

td {
  padding: var(--space-2) var(--space-3);
  vertical-align: top;
  border-top: 1px solid var(--color-border);
}

.time-col {
  width: 5rem;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.level-col {
  width: 6rem;
  white-space: nowrap;
}

.source-col {
  width: 10rem;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

.message-col {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.backend-log-empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
</style>
