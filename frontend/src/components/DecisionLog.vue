<!--
  The per-tick decision log shared by the live and replay stages (see
  plans/stage-04.5/information-architecture.md). A two-column table, Tick | Decision, of the agent's
  action each tick — data already in the state stream (`StepState.agents[slot].action`), so the log
  needs no new transport. It scrolls independently and follows the active row: the latest tick on a
  live session, the scrubbed tick on a replay. The caller provides the section label (a heading beside
  the canvas, or a disclosure summary below it), so this component is just the table.

  The cells are terse by nature — an action is all an agent emits per tick — and the value is formatted
  generically (formatAction): naming an action is the renderer's job, not the host log's.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { formatAction } from '../lib/format.js'

export interface DecisionEntry {
  tick: number
  action: unknown
}

const props = withDefaults(
  defineProps<{
    entries: DecisionEntry[]
    /** The row to mark current and scroll to (a scrubbed replay). Null follows the latest row (live). */
    currentIndex?: number | null
  }>(),
  { currentIndex: null },
)

const scroller = ref<HTMLElement | null>(null)
const activeIndex = computed(() =>
  props.currentIndex ?? (props.entries.length > 0 ? props.entries.length - 1 : -1),
)

// Follow the active row: a live log tracks the latest tick, a scrubbed replay tracks the scrubber.
// Best-effort — jsdom has no layout so this is a no-op there, but it never throws.
watch(
  [() => props.entries.length, activeIndex],
  () => {
    const el = scroller.value
    if (el === null) {
      return
    }
    const active = el.querySelector<HTMLElement>('[data-active="true"]')
    el.scrollTop = active === null ? el.scrollHeight : active.offsetTop - el.clientHeight / 2
  },
  { flush: 'post' },
)
</script>

<template>
  <div class="decision-log" ref="scroller">
    <table>
      <thead>
        <tr>
          <th class="tick-col" scope="col">Tick</th>
          <th scope="col">Decision</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(entry, i) in entries"
          :key="entry.tick"
          :data-active="i === activeIndex || undefined"
          :aria-current="i === activeIndex ? 'true' : undefined"
        >
          <td class="tick-col">{{ entry.tick }}</td>
          <td>{{ formatAction(entry.action) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="entries.length === 0" class="decision-empty">No decisions yet.</p>
  </div>
</template>

<style scoped>
.decision-log {
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
  overflow-wrap: anywhere;
}

.tick-col {
  width: 4rem;
  color: var(--color-text-muted);
}

/* The current row (latest live tick, or the scrubbed replay tick) is marked, never by color alone:
   it carries aria-current and a left accent rule plus a raised background. */
tr[data-active='true'] td {
  background: var(--color-surface-raised);
}

tr[data-active='true'] td:first-child {
  box-shadow: inset 3px 0 0 var(--color-accent);
}

.decision-empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
</style>
