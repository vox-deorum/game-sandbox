<!--
  The merged replay thread: the decision log and the chat woven into one chronological feed. A replay
  scrubs a whole recorded game, so unlike the split live stage this shows both threads at once: the
  decision for every tick (the whole game, ticks ahead of the scrubber dimmed, the current tick
  highlighted) with each tick's messages interleaved right after it.

  The chat the caller passes is already filtered to the transport position (visibleChat), so messages
  reveal progressively as the scrubber reaches their tick while the decisions stay fully listed. Each
  message hangs off its tick's decision group, so the caller must supply a decision for every tick that
  carries chat (ReplayPage derives both from the same parsed states); a message on a tick with no
  decision row is never rendered. Rows render through the same shared helpers the split panels use:
  formatAction/formatPlayer for a decision line, playerName (the compact id unless the renderer supplies
  names) for a message's player, and attributionLabel plus the shared broadcast/to-you/from-you badge for
  a message's sender, so the merged view honours the same blind policy and stays legible on a
  same-labelled roster.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { computed, ref } from 'vue'

import type { RecordingLlmCall } from '../api/client.js'
import { useActiveRowScroll } from '../composables/useActiveRowScroll.js'
import { attributionLabel } from '../lib/attribution.js'
import { type ChatEntry, type MessageBadge, messageBadge, messageKey } from '../lib/chat.js'
import { formatAction, formatPlayer, playerName } from '../lib/format.js'
import type { DecisionEntry } from '../lib/state.js'
import LlmCostDetails from './LlmCostDetails.vue'
import LlmCostTooltip from './LlmCostTooltip.vue'
import RequestResponseView from './RequestResponseView.vue'
import UiBadge from './ui/UiBadge.vue'
import UiButton from './ui/UiButton.vue'
import UiDialog from './ui/UiDialog.vue'

const props = withDefaults(
  defineProps<{
    /** Every action-bearing decision, ordered by state tick and canonical player order. */
    decisions: DecisionEntry[]
    /** Messages already filtered to the transport position, so future ticks carry none. */
    chat: ChatEntry[]
    /** The state tick to mark current (a replay). Null follows the latest tick. */
    currentTick?: number | null
    /** The recording header's players map: sender labels for message rows. */
    players?: RecordingHeader['players']
    /** Attribution context, threaded from the page exactly as PlayerAttribution takes it. */
    blind?: boolean
    viewerId?: string
    anonymousNumbers?: Record<string, number>
    /** Players the viewer controls; empty when spectating a replay (the usual case). */
    viewerPlayers?: string[]
    llmCalls?: RecordingLlmCall[]
    setupLlmCalls?: RecordingLlmCall[]
    llmUnavailable?: boolean
    llmPending?: boolean
    /**
     * Environment-supplied display names for message rows, keyed by player id; absent shows the
     * compact player id. Decision rows are the raw decision log and always show the compact id.
     */
    playerNames?: Readonly<Record<string, string>>
  }>(),
  {
    currentTick: null,
    players: undefined,
    blind: false,
    viewerId: undefined,
    anonymousNumbers: undefined,
    viewerPlayers: () => [],
    llmCalls: () => [],
    setupLlmCalls: () => [],
    llmUnavailable: false,
    llmPending: false,
    playerNames: undefined,
  },
)

const attributionCtx = computed(() => ({
  blind: props.blind,
  viewerId: props.viewerId,
  anonymousNumbers: props.anonymousNumbers,
}))

function labelFor(playerId: string): string {
  return attributionLabel(playerId, props.players?.[playerId], attributionCtx.value)
}

const activeTick = computed(() => props.currentTick ?? props.decisions.at(-1)?.tick ?? null)

// Group the position-filtered messages by their recorded state tick.
const chatByTick = computed(() => {
  const map = new Map<number, ChatEntry[]>()
  for (const entry of props.chat) {
    const list = map.get(entry.tick)
    if (list === undefined) {
      map.set(entry.tick, [entry])
    } else {
      list.push(entry)
    }
  }
  return map
})

type ThreadState = 'past' | 'current' | 'future'

interface DecisionItem {
  key: string
  kind: 'decision'
  state: ThreadState
  player: string
  action: string
  tick: number
  playerId: string
  currentMarker: boolean
}

interface MessageItem {
  key: string
  kind: 'message'
  state: ThreadState
  player: string
  sender: string
  badge: MessageBadge
  text: string
  tick: number
}

type ThreadItem = DecisionItem | MessageItem

// Weave complete decision groups and messages into one ordered list. Messages are appended once after
// every action-bearing entry for their tick.
const items = computed<ThreadItem[]>(() => {
  const result: ThreadItem[] = []
  const byTick = new Map<number, DecisionEntry[]>()
  for (const decision of props.decisions) {
    const group = byTick.get(decision.tick)
    if (group === undefined) {
      byTick.set(decision.tick, [decision])
    } else {
      group.push(decision)
    }
  }

  for (const [tick, decisions] of byTick) {
    const state: ThreadState =
      tick === activeTick.value ? 'current' : activeTick.value !== null && tick > activeTick.value ? 'future' : 'past'
    decisions.forEach((decision, index) => {
      result.push({
        key: `d-${decision.tick}-${decision.player}`,
        kind: 'decision',
        state,
        player: decision.player ? formatPlayer(decision.player) : 'None',
        action: formatAction(decision.action),
        tick: decision.tick,
        playerId: decision.player,
        currentMarker: state === 'current' && index === 0,
      })
    })
    for (const entry of chatByTick.value.get(tick) ?? []) {
      result.push({
        key: `m-${messageKey(entry)}`,
        kind: 'message',
        state: state === 'future' ? 'past' : state,
        player: playerName(entry.from, props.playerNames),
        sender: labelFor(entry.from),
        badge: messageBadge(entry, props.viewerPlayers, props.playerNames),
        text: entry.text,
        tick: entry.tick,
      })
    }
  }
  return result
})

const setupRows = computed(() => {
  if (props.llmUnavailable) return []
  const byPlayer = new Map<string, RecordingLlmCall[]>()
  for (const call of props.setupLlmCalls) {
    const calls = byPlayer.get(call.player) ?? []
    calls.push(call)
    byPlayer.set(call.player, calls)
  }
  return [...byPlayer.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([player, calls]) => ({ player, calls }))
})

function decisionCalls(item: DecisionItem): RecordingLlmCall[] {
  return props.llmCalls.filter((call) => call.tick === item.tick && call.player === item.playerId)
}

function totalCost(calls: RecordingLlmCall[]): number {
  return calls.reduce((total, call) => total + call.budget_cost_units, 0)
}

function hasBodies(call: RecordingLlmCall): boolean {
  return Object.hasOwn(call, 'request') && Object.hasOwn(call, 'completion')
}

const inspectorOpen = ref(false)
const inspectedCalls = ref<RecordingLlmCall[]>([])

function inspect(calls: RecordingLlmCall[]): void {
  if (!calls.every(hasBodies)) return
  inspectedCalls.value = calls
  inspectorOpen.value = true
}

// Follow the scrubbed row: center the current tick, the same active-row scroll the decision log uses.
const scroller = useActiveRowScroll(
  () => props.decisions.length + setupRows.value.length,
  () => activeTick.value ?? -1,
)
</script>

<template>
  <div class="game-thread" ref="scroller" role="group" aria-label="Game thread">
    <div class="thread-header" aria-hidden="true">
      <span>Player</span>
      <span>Tick</span>
      <span>Decision</span>
      <span>LLM cost</span>
    </div>
    <ul v-if="items.length > 0 || setupRows.length > 0" class="thread-list">
      <li
        v-for="row in setupRows"
        :key="`setup:${row.player}`"
        class="thread-item thread-item--decision"
        :data-row-id="`setup:${row.player}`"
      >
        <span class="thread-player">{{ row.player ? formatPlayer(row.player) : 'None' }}</span>
        <span class="thread-tick">Setup</span>
        <span class="thread-action">Setup</span>
        <span class="thread-cost">
          <LlmCostTooltip
            :calls="row.calls"
            :total-budget-cost-units="totalCost(row.calls)"
            :inspectable="row.calls.every(hasBodies)"
            :accessible-label="row.calls.every(hasBodies) ? 'Inspect request and response' : 'LLM cost details'"
            @inspect="inspect(row.calls)"
          />
        </span>
      </li>
      <li
        v-for="item in items"
        :key="item.key"
        class="thread-item"
        :class="[
          `thread-item--${item.kind}`,
          { 'is-current': item.state === 'current', 'is-future': item.state === 'future' },
        ]"
        :data-active="(item.kind === 'decision' && item.state === 'current') || undefined"
        :aria-current="item.kind === 'decision' && item.currentMarker ? 'true' : undefined"
      >
        <template v-if="item.kind === 'decision'">
          <span class="thread-player">{{ item.player }}</span>
          <span class="thread-tick">tick {{ item.tick }}</span>
          <span class="thread-action">{{ item.action }}</span>
          <span class="thread-cost">
            <template v-if="llmPending">Loading</template>
            <template v-else-if="llmUnavailable">Unavailable</template>
            <template v-else-if="decisionCalls(item).length === 0">None</template>
            <LlmCostTooltip
              v-else
              :calls="decisionCalls(item)"
              :total-budget-cost-units="totalCost(decisionCalls(item))"
              :inspectable="decisionCalls(item).every(hasBodies)"
              :accessible-label="decisionCalls(item).every(hasBodies) ? 'Inspect request and response' : 'LLM cost details'"
              @inspect="inspect(decisionCalls(item))"
            />
          </span>
        </template>
        <template v-else>
          <div class="thread-meta">
            <span class="thread-msg-player">{{ item.player }}</span>
            <span class="thread-from">{{ item.sender }}</span>
            <UiBadge :variant="item.badge.variant">{{ item.badge.text }}</UiBadge>
            <span class="thread-tick">tick {{ item.tick }}</span>
          </div>
          <p class="thread-text">{{ item.text }}</p>
        </template>
      </li>
    </ul>
    <p v-else class="thread-empty">No decisions yet.</p>

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
          <RequestResponseView :request="call.request" :response="call.completion" />
        </details>
      </div>
      <div class="inspector-actions">
        <UiButton variant="secondary" @click="inspectorOpen = false">Close</UiButton>
      </div>
    </UiDialog>
  </div>
</template>

<style scoped>
.game-thread {
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.thread-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.thread-header,
.thread-item--decision {
  display: grid;
  grid-template-columns: 5rem 4rem minmax(0, 1fr) max-content;
  gap: var(--space-2);
  align-items: baseline;
}

.thread-header {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
}

.thread-item {
  border-top: 1px solid var(--color-border);
}

.thread-item:first-child {
  border-top: none;
}

/* A decision is a terse mono line: player, action, and tick, like the decision log's cells. */
.thread-item--decision {
  padding: var(--space-1) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.thread-cost {
  white-space: nowrap;
}

.call-inspector-list {
  display: grid;
  gap: var(--space-3);
}

.inspector-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-4);
}

.thread-player {
  color: var(--color-text-muted);
}

.thread-action {
  overflow-wrap: anywhere;
}

/* A message is the richer chat block — the same meta line and body ChatPanel renders. */
.thread-item--message {
  padding: var(--space-2) var(--space-3);
}

.thread-meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.thread-msg-player {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.thread-from {
  font-weight: 600;
  font-size: var(--text-xs);
}

.thread-tick {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.thread-text {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

/* The scrubbed tick, marked never by color alone: its decision row carries aria-current, and the whole
   tick block (the decision plus the messages riding it) takes a left accent rule and raised background,
   mirroring the decision log's active row. */
.thread-item.is-current {
  background: var(--color-surface-raised);
  box-shadow: inset 3px 0 0 var(--color-accent);
}

/* Ticks ahead of the scrubber stay visible so the whole game reads at a glance, but dimmed. */
.thread-item.is-future {
  opacity: 0.45;
}

.thread-empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
</style>
