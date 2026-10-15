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
  formatAction for decisions, PlayerTag for compact player ids (which name and highlight the player in
  the game frame), and senderIdentity plus the shared recipient badge (broadcast, to you, or to another
  player) for messages. The merged view therefore honours the same blind policy and stays legible on a
  same-labelled roster.

  A whole game can run to thousands of rows, so a long thread mounts only the rows near the viewport,
  with spacers standing in for the rest (see useVirtualLog). The rows themselves never carry the
  scrubber position: each rendered row reads its past, current, or future state from the current tick,
  so scrubbing restyles a handful of rows instead of rebuilding the thread.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { computed, ref } from 'vue'

import type { RecordingLlmCall } from '../api/client.js'
import { usePlayerIdentity } from '../composables/usePlayerIdentity.js'
import {
  type ChatEntry,
  type MessageBadge,
  messageBadge,
  messageKey,
  type SenderIdentity,
  senderIdentity,
} from '../lib/chat.js'
import { useVirtualLog } from '../composables/useVirtualLog.js'
import { formatAction } from '../lib/format.js'
import { decisionCallsKey, groupSetupCalls, indexDecisionCalls } from '../lib/llm.js'
import type { DecisionEntry } from '../lib/state.js'
import LlmCostDetails from './LlmCostDetails.vue'
import LlmCostTooltip from './LlmCostTooltip.vue'
import PlayerTag from './PlayerTag.vue'
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
    /** Attribution context, passed to the shared sender-label helper. */
    blind?: boolean
    /** The viewer never sees real names: hash-label every non-own human and submitted agent. */
    masked?: boolean
    viewerId?: string
    anonymousNumbers?: Record<string, number>
    /** Players the viewer controls; empty when spectating a replay (the usual case). */
    viewerPlayers?: string[]
    llmCalls?: RecordingLlmCall[]
    setupLlmCalls?: RecordingLlmCall[]
    llmUnavailable?: boolean
    llmPending?: boolean
  }>(),
  {
    currentTick: null,
    players: undefined,
    blind: false,
    masked: false,
    viewerId: undefined,
    anonymousNumbers: undefined,
    viewerPlayers: () => [],
    llmCalls: () => [],
    setupLlmCalls: () => [],
    llmUnavailable: false,
    llmPending: false,
  },
)

const attributionCtx = computed(() => ({
  blind: props.blind,
  masked: props.masked,
  viewerId: props.viewerId,
  anonymousNumbers: props.anonymousNumbers,
}))

const identity = usePlayerIdentity()

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
  action: string
  tick: number
  playerId: string
}

interface MessageItem {
  key: string
  kind: 'message'
  playerId: string
  sender: SenderIdentity
  badge: MessageBadge
  text: string
  tick: number
}

type ThreadItem = DecisionItem | MessageItem

// The decision rows grouped by tick, built only when the decisions change.
const decisionGroups = computed(() => {
  const byTick = new Map<number, DecisionItem[]>()
  for (const decision of props.decisions) {
    const item: DecisionItem = {
      key: `d-${decision.tick}-${decision.player}`,
      kind: 'decision',
      action: formatAction(decision.action),
      tick: decision.tick,
      playerId: decision.player,
    }
    const group = byTick.get(decision.tick)
    if (group === undefined) {
      byTick.set(decision.tick, [item])
    } else {
      group.push(item)
    }
  }
  return byTick
})

// Weave complete decision groups and messages into one ordered list. Messages are appended once after
// every action-bearing entry for their tick.
const items = computed<ThreadItem[]>(() => {
  const result: ThreadItem[] = []
  for (const [tick, decisions] of decisionGroups.value) {
    for (const decision of decisions) {
      result.push(decision)
    }
    for (const entry of chatByTick.value.get(tick) ?? []) {
      result.push({
        key: `m-${messageKey(entry)}`,
        kind: 'message',
        playerId: entry.from,
        sender: senderIdentity(
          entry.from,
          identity.profiles.value,
          props.players,
          attributionCtx.value,
          props.viewerPlayers,
        ),
        badge: messageBadge(entry, props.players, attributionCtx.value, props.viewerPlayers),
        text: entry.text,
        tick: entry.tick,
      })
    }
  }
  return result
})

// The current tick's block is highlighted and the ticks ahead of it dimmed. A message is never ahead:
// the caller reveals messages only up to the current tick.
function rowState(item: ThreadItem): ThreadState {
  if (item.tick === activeTick.value) return 'current'
  return item.kind === 'decision' && activeTick.value !== null && item.tick > activeTick.value
    ? 'future'
    : 'past'
}

// The first decision of the current tick, which carries aria-current and is the row the log follows.
const activeIndex = computed(() =>
  items.value.findIndex((item) => item.kind === 'decision' && item.tick === activeTick.value),
)

const setupRows = computed(() => (props.llmUnavailable ? [] : groupSetupCalls(props.setupLlmCalls)))

const callsByDecision = computed(() => indexDecisionCalls(props.llmCalls))

function decisionCalls(item: DecisionItem): RecordingLlmCall[] {
  return callsByDecision.value.get(decisionCallsKey(item.tick, item.playerId)) ?? []
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
const { scroller, listStart, rows, padding, measure, virtual } = useVirtualLog({
  items: () => items.value,
  key: (item) => item.key,
  activeIndex: () => activeIndex.value,
  leadingRows: () => setupRows.value.length,
  estimateSize: (item) => (item.kind === 'decision' ? 23 : 56),
})
</script>

<template>
  <div class="game-thread" ref="scroller" role="group" aria-label="Game thread">
    <div v-if="items.length > 0 || setupRows.length > 0" class="thread-table">
      <div class="thread-header" aria-hidden="true">
        <span>Player</span>
        <span>Tick</span>
        <span>Decision</span>
        <span>LLM cost</span>
      </div>
      <ul class="thread-list">
        <li
          v-for="row in setupRows"
          :key="`setup:${row.player}`"
          class="thread-item thread-item--decision"
          :data-row-id="`setup:${row.player}`"
        >
          <PlayerTag class="thread-player" :player-id="row.player" />
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
          v-if="virtual"
          ref="listStart"
          class="virtual-spacer"
          aria-hidden="true"
          :style="{ height: `${padding.top}px` }"
        />
        <li
          v-for="{ index, item } in rows"
          :key="item.key"
          :ref="measure"
          :data-index="index"
          class="thread-item"
          :class="[
            `thread-item--${item.kind}`,
            { 'is-current': rowState(item) === 'current', 'is-future': rowState(item) === 'future' },
          ]"
          :data-active="(item.kind === 'decision' && rowState(item) === 'current') || undefined"
          :aria-current="index === activeIndex ? 'true' : undefined"
        >
          <template v-if="item.kind === 'decision'">
            <PlayerTag class="thread-player" :player-id="item.playerId" />
            <span class="thread-tick">{{ item.tick }}</span>
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
              <PlayerTag class="thread-msg-player" :player-id="item.playerId" />
              <span class="thread-from" :class="`thread-from--${item.sender.tone}`">{{ item.sender.label }}</span>
              <UiBadge :variant="item.badge.variant">
                <template v-if="item.badge.kind === 'broadcast'">broadcast</template>
                <template v-else-if="item.badge.kind === 'to-you'">to you</template>
                <template v-else>to <PlayerTag :player-id="item.badge.playerId" /></template>
              </UiBadge>
              <span class="thread-tick">tick {{ item.tick }}</span>
            </div>
            <p class="thread-text">{{ item.text }}</p>
          </template>
        </li>
        <li
          v-if="virtual"
          class="virtual-spacer"
          aria-hidden="true"
          :style="{ height: `${padding.bottom}px` }"
        />
      </ul>
    </div>
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
  font-size: var(--text-xs);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

/* One shared grid sizes the columns for every row. Player, tick, and cost shrink to their widest cell,
   the decision takes the rest, and each row joins the columns through subgrid, so the header and every
   decision line up even in a narrow side panel. Messages span the full width below their tick. */
.thread-table {
  display: grid;
  grid-template-columns: max-content max-content minmax(0, 1fr) max-content;
  column-gap: var(--space-2);
}

.thread-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.thread-header,
.thread-list,
.thread-item,
.virtual-spacer {
  grid-column: 1 / -1;
}

.thread-header,
.thread-list,
.thread-item--decision {
  display: grid;
  grid-template-columns: subgrid;
}

.thread-header,
.thread-item--decision {
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
  font-weight: 600;
}

.thread-item {
  border-top: 1px solid var(--color-border);
}

/* The first row has no rule above it. In a long thread the top spacer leads the list, so the first
   row is the one right after an empty spacer. */
.thread-item:first-child,
.virtual-spacer:first-child + .thread-item[data-index='0'] {
  border-top: none;
}

/* A decision is a terse mono line: player, action, and tick, like the decision log's cells. */
.thread-item--decision {
  padding: var(--space-1) var(--space-3);
  font-family: var(--font-mono);
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
  color: var(--color-text-muted);
}

.thread-from {
  font-weight: 600;
}

/* The sender's color says whose it is, matching the live chat panel. */
.thread-from--own {
  color: var(--color-accent);
}

.thread-from--ally {
  color: var(--color-ally);
}

.thread-tick {
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}

.thread-meta .thread-tick {
  margin-left: auto;
}

.thread-text {
  margin: var(--space-1) 0 0;
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
}
</style>
