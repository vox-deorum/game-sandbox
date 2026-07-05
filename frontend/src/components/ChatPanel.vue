<!--
  The messaging panel shared by the live and replay stages (Stage 8). Like DecisionLog, it is host
  chrome, not renderer content: the environment knows nothing about it, and any future messaging
  environment gets it for free. It is a pure function of the message entries the caller accumulates
  (from the state stream on the session page, from the parsed recording on the replay page) plus the
  attribution context the rest of the session chrome already threads, so it needs no transport of its
  own — it emits `send` and lets the page own the socket.

  Each entry is badged for what it is: a broadcast, a message "to you", a message "from you" (the
  relay reflects a controller's own sends back on the recorded line), or, on a replay, a targeted
  message between other seats. Sender labels come through the shared `attributionLabel`, so the panel
  honours the same blind policy as the attribution line and the decision log.

  When sendable, the composer counts the draft in Unicode code points through the same shared counter
  the relay's cap pre-gate uses, so the browser can never disagree with the harness about what fits.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { codePointLength } from '@game-sandbox/schema/text'
import { computed, ref, watch } from 'vue'

import { attributionLabel } from '../lib/attribution.js'
import { formatSlot } from '../lib/format.js'
import UiBadge from './ui/UiBadge.vue'
import UiButton from './ui/UiButton.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'
import UiSelect from './ui/UiSelect.vue'

/** One message as the panel renders it: the wire message plus the tick of the state it rode in on. */
export interface ChatEntry {
  tick: number
  from: string
  /** Recipient slot id, or null for a broadcast. */
  to: string | null
  text: string
}

const props = withDefaults(
  defineProps<{
    entries: ChatEntry[]
    /** The recording header's players map: sender labels and the recipient options. */
    players?: RecordingHeader['players']
    /** Attribution context, threaded from the page exactly as PlayerAttribution takes it. */
    blind?: boolean
    viewerId?: string
    anonymousNumbers?: Record<string, number>
    /** Slots the connected viewer controls; drives the "to you"/"from you" badges. Empty when spectating. */
    viewerSlots?: string[]
    /** Show the composer. The page decides (owner + human mode + running + controls a slot). */
    sendable?: boolean
    /** Whether the transport can actually carry a send right now. False during a reconnect, when the
     *  socket silently no-ops: the composer stays mounted (the draft is preserved) but Send is disabled,
     *  so a typed message is never cleared into a dropped send. */
    connected?: boolean
    /** Effective code-point cap from the session row; null is uncapped. */
    messageCap?: number | null
  }>(),
  {
    players: undefined,
    blind: false,
    viewerId: undefined,
    anonymousNumbers: undefined,
    viewerSlots: () => [],
    sendable: false,
    connected: true,
    messageCap: null,
  },
)

const emit = defineEmits<{ send: [payload: { to: string | null; text: string }] }>()

const attributionCtx = computed(() => ({
  blind: props.blind,
  viewerId: props.viewerId,
  anonymousNumbers: props.anonymousNumbers,
}))

/** A stable, unique identity for an entry: the tuple the harness guarantees is unique within a run. */
function keyOf(entry: ChatEntry): string {
  return JSON.stringify([entry.tick, entry.from, entry.to, entry.text])
}

function labelFor(slot: string): string {
  return attributionLabel(slot, props.players?.[slot], attributionCtx.value)
}

/** The badge for an entry: the viewer's own send wins over the recipient's identity. A targeted line
 *  names the recipient by seat (`formatSlot`) so two seats sharing an agent label stay distinguishable,
 *  matching how the recipient options and the sender line disambiguate. */
function badgeFor(entry: ChatEntry): { variant: 'neutral' | 'accent'; text: string } {
  if (props.viewerSlots.includes(entry.from)) {
    return { variant: 'accent', text: 'from you' }
  }
  if (entry.to !== null && props.viewerSlots.includes(entry.to)) {
    return { variant: 'accent', text: 'to you' }
  }
  if (entry.to === null) {
    return { variant: 'neutral', text: 'broadcast' }
  }
  return { variant: 'neutral', text: `to ${formatSlot(entry.to)}` }
}

// Decorate once so the template reads each derived field without recomputing per binding. The seat
// (`formatSlot`) rides alongside the attribution label the same way PlayerAttribution pairs them, so a
// roster of same-labelled agents (three "Naive agent" seats in a default Spades table) stays legible.
const rows = computed(() =>
  props.entries.map((entry) => ({
    key: keyOf(entry),
    tick: entry.tick,
    text: entry.text,
    seat: formatSlot(entry.from),
    sender: labelFor(entry.from),
    badge: badgeFor(entry),
  })),
)

// The recipient options: every other seat, each prefixed with its seat so identical agent labels are
// still tellable apart in the dropdown. "Everyone" (a broadcast) is the empty-value option in the template.
const recipientOptions = computed(() =>
  Object.keys(props.players ?? {})
    .filter((slot) => !props.viewerSlots.includes(slot))
    .map((slot) => ({ value: slot, label: `${formatSlot(slot)} · ${labelFor(slot)}` })),
)

const recipient = ref('') // '' is the "Everyone" broadcast option.
const draft = ref('')
const count = computed(() => codePointLength(draft.value))
const overCap = computed(() => props.messageCap !== null && count.value > props.messageCap)
// The draft is sendable only when the transport can carry it: gating on `connected` here means a
// reconnect (when the socket silently no-ops) both disables Send and blocks the submit path, so the
// draft is never cleared into a dropped send.
const canSend = computed(() => count.value > 0 && !overCap.value && props.connected)
// The code-point count against the cap, shown under the field. Bare when uncapped.
const counterText = computed(() =>
  props.messageCap === null ? String(count.value) : `${count.value}/${props.messageCap}`,
)

function submit(): void {
  if (!canSend.value) {
    return
  }
  emit('send', { to: recipient.value === '' ? null : recipient.value, text: draft.value })
  draft.value = ''
}

// Follow the latest message. Best-effort — jsdom has no layout so this is a no-op there, but it never
// throws (mirrors DecisionLog's scroll-follow).
const scroller = ref<HTMLElement | null>(null)
watch(
  () => props.entries.length,
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
  <div class="chat-panel" :aria-label="sendable ? 'Chat' : 'Chat log'" role="group">
    <div class="chat-scroll" ref="scroller">
      <ul v-if="rows.length > 0" class="chat-list">
        <li v-for="row in rows" :key="row.key" class="chat-entry">
          <div class="chat-meta">
            <span class="chat-seat">{{ row.seat }}</span>
            <span class="chat-from">{{ row.sender }}</span>
            <UiBadge :variant="row.badge.variant">{{ row.badge.text }}</UiBadge>
            <span class="chat-tick">tick {{ row.tick }}</span>
          </div>
          <p class="chat-text">{{ row.text }}</p>
        </li>
      </ul>
      <p v-else class="chat-empty">No messages yet.</p>
    </div>

    <form v-if="sendable" class="chat-composer" @submit.prevent="submit">
      <UiField label="Recipient" class="chat-field">
        <template #default="{ id, describedby }">
          <UiSelect :id="id" v-model="recipient" :aria-describedby="describedby">
            <option value="">Everyone</option>
            <option v-for="opt in recipientOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </UiSelect>
        </template>
      </UiField>
      <UiField
        label="Message"
        class="chat-field chat-field--grow"
        :hint="overCap ? undefined : counterText"
        :error="overCap ? counterText : undefined"
      >
        <template #default="{ id, describedby, invalid }">
          <UiInput
            :id="id"
            v-model="draft"
            type="text"
            autocomplete="off"
            :invalid="invalid"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>
      <UiButton type="submit" :disabled="!canSend">Send</UiButton>
    </form>
  </div>
</template>

<style scoped>
/* The panel fills the height its host body defines and splits it: the message list scrolls, the
   composer stays pinned at the bottom. */
.chat-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.chat-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.chat-entry {
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
}

.chat-entry:first-child {
  border-top: none;
}

.chat-meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
}

/* The seat rides ahead of the sender label the same way PlayerAttribution pairs them, so same-labelled
   agents stay tellable apart. */
.chat-seat {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.chat-from {
  font-weight: 600;
  font-size: var(--text-xs);
}

.chat-tick {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.chat-text {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.chat-empty {
  margin: 0;
  padding: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

/* The composer lays the recipient select, the message field, and Send on one row; the message field
   grows and the button aligns to the control line. The fields and button are the shared Ui primitives,
   so their look and accessibility wiring come from the design system, not local CSS. */
.chat-composer {
  display: flex;
  align-items: end;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface-raised);
}

/* min-width:0 lets the grow field shrink below its content width in the flex row. */
.chat-field {
  min-width: 0;
}

.chat-field--grow {
  flex: 1;
}
</style>
