/**
 * The chat message shape and the pure helpers shared by every surface that renders messages: the live
 * ChatPanel, the merged replay GameThread, and SessionPage's dedup of the reconnect-replayed state
 * stream. Keeping the identity tuple and the badge policy here means the three surfaces cannot drift
 * out of agreement: a change to how a message is keyed or badged lands in one place.
 */
import { formatSlot } from './format.js'

/** One message as the panels render it: the wire message plus the tick of the state it rode in on. */
export interface ChatEntry {
  tick: number
  from: string
  /** Recipient slot id, or null for a broadcast. */
  to: string | null
  text: string
}

/** The badge shown for a message: its variant and label. */
export interface MessageBadge {
  variant: 'neutral' | 'accent'
  text: string
}

/**
 * A stable, unique identity for a message: the tuple the harness guarantees is unique within a run.
 * The live list keys, the merged thread's keys, and SessionPage's reconnect dedup all derive identity
 * here so they stay in lockstep (the dedup key and the render keys must agree or a replayed message
 * either duplicates or clobbers a row).
 */
export function messageKey(entry: ChatEntry): string {
  return JSON.stringify([entry.tick, entry.from, entry.to, entry.text])
}

/**
 * The badge for a message: the viewer's own send wins over the recipient's identity, then a targeted
 * line names its recipient by seat (`formatSlot`) so two seats sharing an agent label stay
 * distinguishable. On a replay `viewerSlots` is empty, so this is broadcast or `to {seat}`.
 */
export function messageBadge(entry: ChatEntry, viewerSlots: string[]): MessageBadge {
  if (viewerSlots.includes(entry.from)) {
    return { variant: 'accent', text: 'from you' }
  }
  if (entry.to !== null && viewerSlots.includes(entry.to)) {
    return { variant: 'accent', text: 'to you' }
  }
  if (entry.to === null) {
    return { variant: 'neutral', text: 'broadcast' }
  }
  return { variant: 'neutral', text: `to ${formatSlot(entry.to)}` }
}
