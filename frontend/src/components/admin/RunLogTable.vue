<!--
  The run's container logs as a table, on the run-details page. Mirrors the decision-log pattern
  (DecisionLog.vue): a scrollable, monospace table that auto-follows the latest line as the live
  stream appends. Each line carries the match and game it came from, so the operator can tell which
  container emitted it. The host page owns the line buffer (capping it); this component is just the
  table and its empty state.
-->
<script setup lang="ts">
import { ref, watch } from 'vue'

export interface RunLogLine {
  match_index: number
  game_index: number
  line: string
}

const props = defineProps<{ lines: RunLogLine[] }>()

const scroller = ref<HTMLElement | null>(null)

// Follow the tail: keep the newest line in view as the stream appends. Best-effort — jsdom has no
// layout so this is a no-op there, but it never throws.
watch(
  () => props.lines.length,
  () => {
    const el = scroller.value
    if (el !== null) {
      el.scrollTop = el.scrollHeight
    }
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="run-log" ref="scroller">
    <table>
      <thead>
        <tr>
          <th class="match-col" scope="col">Match</th>
          <th class="game-col" scope="col">Game</th>
          <th scope="col">Line</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(entry, i) in lines" :key="i" data-testid="log-line">
          <td class="match-col">m{{ entry.match_index }}</td>
          <td class="game-col">g{{ entry.game_index }}</td>
          <td class="line-col">{{ entry.line }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="lines.length === 0" class="run-log-empty">No log lines yet.</p>
  </div>
</template>

<style scoped>
.run-log {
  max-height: 18rem;
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

th {
  position: sticky;
  top: 0;
  text-align: left;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-weight: 600;
}

td {
  padding: var(--space-1) var(--space-3);
  border-top: 1px solid var(--color-border);
}

.match-col,
.game-col {
  width: 3.5rem;
  color: var(--color-text-muted);
}

.line-col {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.run-log-empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
</style>
