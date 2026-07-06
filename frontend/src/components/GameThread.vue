<!--
  The merged replay thread: the decision log and the chat woven into one chronological feed. A replay
  scrubs a whole recorded game, so unlike the split live stage this shows both threads at once — the
  decision for every tick (the whole game, ticks ahead of the scrubber dimmed, the current tick
  highlighted) with each tick's messages interleaved right after it.

  The chat the caller passes is already filtered to the transport position (visibleChat), so messages
  reveal progressively as the scrubber reaches their tick while the decisions stay fully listed. Each
  message hangs off its tick's decision row, so the caller must supply a decision for every tick that
  carries chat (ReplayPage derives both from the same parsed states); a message on a tick with no
  decision row is never rendered. Rows render through the same shared helpers the split panels use:
  formatAction/formatSlotIndex for a decision line, attributionLabel plus the shared broadcast/to-you/
  from-you badge for a message, so the merged view honours the same blind policy and stays legible on a
  same-labelled roster.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { computed } from 'vue'

import { useActiveRowScroll } from '../composables/useActiveRowScroll.js'
import { attributionLabel } from '../lib/attribution.js'
import { type ChatEntry, type MessageBadge, messageBadge, messageKey } from '../lib/chat.js'
import { formatAction, formatSlot, formatSlotIndex } from '../lib/format.js'
import type { DecisionEntry } from './DecisionLog.vue'
import UiBadge from './ui/UiBadge.vue'

const props = withDefaults(
  defineProps<{
    /** One decision per tick, in order — the whole recorded game. */
    decisions: DecisionEntry[]
    /** Messages already filtered to the transport position, so future ticks carry none. */
    chat: ChatEntry[]
    /** The row to mark current and scroll to (the scrubbed tick). Null follows the latest row. */
    currentIndex?: number | null
    /** The recording header's players map: sender labels for message rows. */
    players?: RecordingHeader['players']
    /** Attribution context, threaded from the page exactly as PlayerAttribution takes it. */
    blind?: boolean
    viewerId?: string
    anonymousNumbers?: Record<string, number>
    /** Slots the viewer controls; empty when spectating a replay (the usual case). */
    viewerSlots?: string[]
  }>(),
  {
    currentIndex: null,
    players: undefined,
    blind: false,
    viewerId: undefined,
    anonymousNumbers: undefined,
    viewerSlots: () => [],
  },
)

const attributionCtx = computed(() => ({
  blind: props.blind,
  viewerId: props.viewerId,
  anonymousNumbers: props.anonymousNumbers,
}))

function labelFor(slot: string): string {
  return attributionLabel(slot, props.players?.[slot], attributionCtx.value)
}

const activeIndex = computed(() =>
  props.currentIndex ?? (props.decisions.length > 0 ? props.decisions.length - 1 : -1),
)

// Group the (already position-filtered) messages by the tick they rode in on, so each decision can
// pull its own tick's messages as it is emitted.
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
  seat: string
  action: string
  tick: number
}

interface MessageItem {
  key: string
  kind: 'message'
  state: ThreadState
  seat: string
  sender: string
  badge: MessageBadge
  text: string
  tick: number
}

type ThreadItem = DecisionItem | MessageItem

// Weave decisions and messages into one ordered list: every tick's decision, then that tick's
// messages. A decision is future (dimmed) past the scrubber, current at it, else past; a message
// shares its decision's state but is never future (the caller filtered future messages out).
const items = computed<ThreadItem[]>(() => {
  const active = activeIndex.value
  const result: ThreadItem[] = []
  props.decisions.forEach((decision, i) => {
    const state: ThreadState = i === active ? 'current' : i > active ? 'future' : 'past'
    result.push({
      key: `d-${decision.tick}-${i}`,
      kind: 'decision',
      state,
      seat: decision.slot ? `P${formatSlotIndex(decision.slot)}` : '—',
      action: formatAction(decision.action),
      tick: decision.tick,
    })
    for (const entry of chatByTick.value.get(decision.tick) ?? []) {
      result.push({
        // The decision index disambiguates the key: if two decisions ever shared a tick, both would
        // pull the same messages and a bare message identity would collide.
        key: `m-${i}-${messageKey(entry)}`,
        kind: 'message',
        state: state === 'future' ? 'past' : state,
        seat: formatSlot(entry.from),
        sender: labelFor(entry.from),
        badge: messageBadge(entry, props.viewerSlots),
        text: entry.text,
        tick: entry.tick,
      })
    }
  })
  return result
})

// Follow the scrubbed row: center the current tick, the same active-row scroll the decision log uses.
const scroller = useActiveRowScroll(
  () => props.decisions.length,
  () => activeIndex.value,
)
</script>

<template>
  <div class="game-thread" ref="scroller" role="group" aria-label="Game thread">
    <ul v-if="items.length > 0" class="thread-list">
      <li
        v-for="item in items"
        :key="item.key"
        class="thread-item"
        :class="[
          `thread-item--${item.kind}`,
          { 'is-current': item.state === 'current', 'is-future': item.state === 'future' },
        ]"
        :data-active="(item.kind === 'decision' && item.state === 'current') || undefined"
        :aria-current="item.kind === 'decision' && item.state === 'current' ? 'true' : undefined"
      >
        <template v-if="item.kind === 'decision'">
          <span class="thread-seat">{{ item.seat }}</span>
          <span class="thread-action">{{ item.action }}</span>
          <span class="thread-tick">tick {{ item.tick }}</span>
        </template>
        <template v-else>
          <div class="thread-meta">
            <span class="thread-msg-seat">{{ item.seat }}</span>
            <span class="thread-from">{{ item.sender }}</span>
            <UiBadge :variant="item.badge.variant">{{ item.badge.text }}</UiBadge>
            <span class="thread-tick">tick {{ item.tick }}</span>
          </div>
          <p class="thread-text">{{ item.text }}</p>
        </template>
      </li>
    </ul>
    <p v-else class="thread-empty">No decisions yet.</p>
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

.thread-item {
  border-top: 1px solid var(--color-border);
}

.thread-item:first-child {
  border-top: none;
}

/* A decision is a terse mono line — seat · action · tick — like the decision log's cells. */
.thread-item--decision {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-1) var(--space-3);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.thread-seat {
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

.thread-msg-seat {
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
