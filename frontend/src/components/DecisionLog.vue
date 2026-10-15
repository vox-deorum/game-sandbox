<!--
  The per-tick decision log shared by the live and replay stages (see
  plans/stage-04.5/information-architecture.md). A two-column table, Tick | Decision, of the agent's
  action each tick, data already in the state stream (`StepState.agents[player].action`), so the log
  needs no new transport. It scrolls independently and follows the active row: the latest tick on a
  live session, the scrubbed tick on a replay. The caller provides the section label (a heading beside
  the canvas, or a disclosure summary below it), so this component is just the table.

  The cells are terse by nature — an action is all an agent emits per tick — and the value is formatted
  generically (formatAction): naming an action is the renderer's job, not the host log's. The player
  cell is a PlayerTag, so a game that names its players shows that name on hover and highlights the
  player's figure. A long log (a Three Branches day) mounts only the rows near the viewport, with
  spacer rows standing in for the rest (see useVirtualLog).
-->
<script setup lang="ts">
import { computed, ref } from 'vue'

import type { RecordingLlmCall } from '../api/client.js'
import { useVirtualLog } from '../composables/useVirtualLog.js'
import { formatAction } from '../lib/format.js'
import { decisionCallsKey, groupSetupCalls, indexDecisionCalls } from '../lib/llm.js'
import type { DecisionEntry } from '../lib/state.js'
import LlmCostDetails from './LlmCostDetails.vue'
import LlmCostTooltip from './LlmCostTooltip.vue'
import PlayerTag from './PlayerTag.vue'
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

const setupRows = computed(() =>
  props.llmUnavailable || props.llmPending ? [] : groupSetupCalls(props.setupLlmCalls ?? []),
)

const callsByDecision = computed(() => indexDecisionCalls(props.llmCalls ?? []))

function decisionCalls(entry: DecisionEntry): RecordingLlmCall[] {
  return callsByDecision.value.get(decisionCallsKey(entry.tick, entry.player)) ?? []
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
const { scroller, listStart, rows, padding, measure, virtual } = useVirtualLog({
  items: () => props.entries,
  key: (entry) => `${entry.tick}:${entry.player}`,
  activeIndex: () => activeIndex.value,
  leadingRows: () => setupRows.value.length,
  estimateSize: () => 25,
})
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
            <PlayerTag :player-id="row.player" />
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
        <tr v-if="virtual" ref="listStart" class="virtual-spacer" aria-hidden="true">
          <td :colspan="showLlmCost ? 4 : 3" :style="{ height: `${padding.top}px` }" />
        </tr>
        <tr
          v-for="{ index, item: entry } in rows"
          :key="`${entry.tick}:${entry.player}`"
          :ref="measure"
          :data-index="index"
          :data-active="entry.tick === activeTick || undefined"
          :aria-current="index === activeIndex ? 'true' : undefined"
        >
          <td class="player-col">
            <PlayerTag :player-id="entry.player" />
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
        <tr v-if="virtual" class="virtual-spacer" aria-hidden="true">
          <td :colspan="showLlmCost ? 4 : 3" :style="{ height: `${padding.bottom}px` }" />
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

/* The stand-in for the unrendered rows of a long log: exactly its inline height, nothing drawn. */
.virtual-spacer td {
  padding: 0;
  border: none;
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
