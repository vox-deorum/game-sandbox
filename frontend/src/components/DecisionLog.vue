<!--
  The per-tick decision log shared by the live and replay stages (see
  plans/stage-04.5/information-architecture.md). A two-column table, Tick | Decision, of the agent's
  action each tick, data already in the state stream (`StepState.agents[player].action`), so the log
  needs no new transport. It scrolls independently and follows the active row: the latest tick on a
  live session, the scrubbed tick on a replay. The caller provides the section label (a heading beside
  the canvas, or a disclosure summary below it), so this component is just the table.

  The cells are terse by nature — an action is all an agent emits per tick — and the value is formatted
  generically (formatAction): naming an action is the renderer's job, not the host log's.
-->
<script setup lang="ts">
import { computed, ref } from 'vue'

import type { RecordingLlmCall } from '../api/client.js'
import { useActiveRowScroll } from '../composables/useActiveRowScroll.js'
import { formatAction, formatPlayer } from '../lib/format.js'
import type { DecisionEntry } from '../lib/state.js'
import LlmCostDetails from './LlmCostDetails.vue'
import LlmCostTooltip from './LlmCostTooltip.vue'
import RequestResponseView from './RequestResponseView.vue'
import UiButton from './ui/UiButton.vue'
import UiDialog from './ui/UiDialog.vue'

const props = withDefaults(
  defineProps<{
    entries: DecisionEntry[]
    /** The state tick to mark current (a replay). Null follows the latest tick (live). */
    currentTick?: number | null
    /** Successful calls attached to normal decisions. Null-tick calls use setupLlmCalls instead. */
    llmCalls?: RecordingLlmCall[]
    /** Successful setup calls, kept separate so they never change decision indexes. */
    setupLlmCalls?: RecordingLlmCall[]
    /** Broken retained telemetry. Every decision cell says Unavailable and no setup rows are invented. */
    llmUnavailable?: boolean
    /** Telemetry is still loading. Every decision cell reports that state instead of a false empty result. */
    llmPending?: boolean
  }>(),
  { currentTick: null, llmUnavailable: false, llmPending: false },
)

interface SetupRow {
  player: string
  calls: RecordingLlmCall[]
}

const setupRows = computed<SetupRow[]>(() => {
  if (props.llmUnavailable || props.llmPending) return []
  const byPlayer = new Map<string, RecordingLlmCall[]>()
  for (const call of props.setupLlmCalls ?? []) {
    const calls = byPlayer.get(call.player) ?? []
    calls.push(call)
    byPlayer.set(call.player, calls)
  }
  return [...byPlayer.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([player, calls]) => ({ player, calls }))
})

function decisionCalls(entry: DecisionEntry): RecordingLlmCall[] {
  return (props.llmCalls ?? []).filter(
    (call) => call.tick === entry.tick && call.player === entry.player,
  )
}

const showLlmCost = computed(
  () =>
    props.llmCalls !== undefined ||
    props.setupLlmCalls !== undefined ||
    props.llmUnavailable ||
    props.llmPending,
)

function totalCost(calls: RecordingLlmCall[]): number {
  return calls.reduce((total, call) => total + call.budget_cost_units, 0)
}

function hasBodies(call: RecordingLlmCall): boolean {
  return Object.hasOwn(call, 'request') && Object.hasOwn(call, 'completion')
}

function costAccessibleLabel(calls: RecordingLlmCall[]): string {
  return calls.every(hasBodies) ? 'Inspect request and response' : 'LLM cost details'
}

const inspectorOpen = ref(false)
const inspectedCalls = ref<RecordingLlmCall[]>([])

function inspect(calls: RecordingLlmCall[]): void {
  if (!calls.every(hasBodies)) return
  inspectedCalls.value = calls
  inspectorOpen.value = true
}

const activeTick = computed(() => props.currentTick ?? props.entries.at(-1)?.tick ?? null)
const activeIndex = computed(() =>
  activeTick.value === null
    ? -1
    : props.entries.findIndex((entry) => entry.tick === activeTick.value),
)

// Follow the first row in the active tick group. Every same-tick row receives the visual highlight.
const scroller = useActiveRowScroll(
  () => props.entries.length + setupRows.value.length,
  () => activeIndex.value,
)
</script>

<template>
  <div class="decision-log" ref="scroller">
    <table>
      <thead>
        <tr>
          <th class="player-col" scope="col">P#</th>
          <th class="tick-col" scope="col">Tick</th>
          <th scope="col">Decision</th>
          <th v-if="showLlmCost" class="cost-col" scope="col">LLM cost</th>
        </tr>
      </thead>
      <tbody v-if="setupRows.length > 0" class="setup-rows">
        <tr
          v-for="row in setupRows"
          :key="`setup:${row.player}`"
          :data-row-id="`setup:${row.player}`"
        >
          <td class="player-col">
            {{ row.player ? formatPlayer(row.player) : 'None' }}
          </td>
          <td class="tick-col">Setup</td>
          <td>Setup</td>
          <td v-if="showLlmCost" class="cost-col">
            <LlmCostTooltip
              :calls="row.calls"
              :total-budget-cost-units="totalCost(row.calls)"
              :inspectable="row.calls.every(hasBodies)"
              :accessible-label="costAccessibleLabel(row.calls)"
              @inspect="inspect(row.calls)"
            />
          </td>
        </tr>
      </tbody>
      <tbody>
        <tr
          v-for="(entry, i) in entries"
          :key="`${entry.tick}:${entry.player}`"
          :data-active="entry.tick === activeTick || undefined"
          :aria-current="i === activeIndex ? 'true' : undefined"
        >
          <td class="player-col">
            {{ entry.player ? formatPlayer(entry.player) : 'None' }}
          </td>
          <td class="tick-col">{{ entry.tick }}</td>
          <td>{{ formatAction(entry.action) }}</td>
          <td v-if="showLlmCost" class="cost-col">
            <template v-if="llmPending">Loading</template>
            <template v-else-if="llmUnavailable">Unavailable</template>
            <template v-else-if="decisionCalls(entry).length === 0"
              >None</template
            >
            <LlmCostTooltip
              v-else
              :calls="decisionCalls(entry)"
              :total-budget-cost-units="totalCost(decisionCalls(entry))"
              :inspectable="decisionCalls(entry).every(hasBodies)"
              :accessible-label="costAccessibleLabel(decisionCalls(entry))"
              @inspect="inspect(decisionCalls(entry))"
            />
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="entries.length === 0" class="decision-empty">No decisions yet.</p>

    <UiDialog v-model:open="inspectorOpen" title="Inspect request and response">
      <LlmCostDetails
        :calls="inspectedCalls"
        :total-budget-cost-units="totalCost(inspectedCalls)"
      />
      <div class="call-inspector-list">
        <details
          v-for="(call, index) in inspectedCalls"
          :key="index"
          :open="inspectedCalls.length === 1"
        >
          <summary>Call {{ index + 1 }} · {{ call.model }}</summary>
          <RequestResponseView
            :request="call.request"
            :response="call.completion"
          />
        </details>
      </div>
      <div class="inspector-actions">
        <UiButton variant="secondary" @click="inspectorOpen = false"
          >Close</UiButton
        >
      </div>
    </UiDialog>
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

.player-col {
  width: 5rem;
  color: var(--color-text-muted);
}

.cost-col {
  white-space: nowrap;
}

.call-inspector-list {
  display: grid;
  gap: var(--space-3);
}

.call-inspector-list summary {
  cursor: pointer;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.inspector-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-4);
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
