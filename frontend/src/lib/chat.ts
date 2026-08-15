/**
 * The chat message shape and the pure helpers shared by every surface that renders messages: the live
 * ChatPanel, the merged replay GameThread, and SessionPage's dedup of the reconnect-replayed state
 * stream. Message identity comes from the shared schema helper, while badge policy stays here.
 */
import { type MessageIdentity, messageKey } from '@game-sandbox/schema/message'

import { formatPlayer } from './format.js'

/** One message as the panels render it: the wire message plus the tick of the state it rode in on. */
export type ChatEntry = MessageIdentity

/** The badge shown for a message: its variant and label. */
export interface MessageBadge {
  variant: 'neutral' | 'accent'
  text: string
}

/**
 * The live list keys, merged thread keys, and SessionPage reconnect dedup use the same schema-owned
 * message identity as environment renderers.
 */
export { messageKey }

/**
 * The badge for a message: the viewer's own send wins over the recipient's identity, then a targeted
 * line names its recipient by its compact player id so two
 * players sharing an agent label stay distinguishable. On a replay `viewerPlayers` is empty, so this is
 * broadcast or `to {player}`.
 */
export function messageBadge(entry: ChatEntry, viewerPlayers: string[]): MessageBadge {
  if (viewerPlayers.includes(entry.from)) {
    return { variant: 'accent', text: 'from you' }
  }
  if (entry.to !== null && viewerPlayers.includes(entry.to)) {
    return { variant: 'accent', text: 'to you' }
  }
  if (entry.to === null) {
    return { variant: 'neutral', text: 'broadcast' }
  }
  return { variant: 'neutral', text: `to ${formatPlayer(entry.to)}` }
}
