/**
 * The chat message shape and the pure helpers shared by every surface that renders messages: the live
 * ChatPanel, the merged replay GameThread, and SessionPage's dedup of the reconnect-replayed state
 * stream. Message identity comes from the shared schema helper, while badge policy stays here.
 */
import type { RecordingHeader } from '@game-sandbox/schema'
import { type MessageIdentity, messageKey } from '@game-sandbox/schema/message'

import type { PlayerProfile } from '../renderers/types.js'
import { type AttributionContext, attributionLabel, isViewerOwned } from './attribution.js'

/** One message as the panels render it: the wire message plus the tick of the state it rode in on. */
export type ChatEntry = MessageIdentity

/**
 * The badge shown for a message: whom it goes to. A message to another player carries that player's id
 * so the surface can render it as a `PlayerTag`.
 */
export type MessageBadge =
  | { variant: 'neutral'; kind: 'broadcast' }
  | { variant: 'accent'; kind: 'to-you' }
  | { variant: 'neutral'; kind: 'to-player'; playerId: string }

/**
 * The live list keys, merged thread keys, and SessionPage reconnect dedup use the same schema-owned
 * message identity as environment renderers.
 */
export { messageKey }

/**
 * Whether a player is the viewer's own: the viewer controls it, or the header attributes it to the
 * viewer. The sender tone and the "to you" badge both ask this, so a row never answers it twice.
 */
export function isViewerPlayer(
  playerId: string,
  players: RecordingHeader['players'] | undefined,
  ctx: AttributionContext,
  viewerPlayers: readonly string[],
): boolean {
  const player = players?.[playerId]
  return viewerPlayers.includes(playerId) || (player !== undefined && isViewerOwned(player, ctx))
}

/**
 * The badge for a message names its recipient: everyone, the viewer, or another player by compact id
 * (so two players sharing an agent label stay distinguishable). Who sent it is the sender label's job,
 * so the viewer's own sends are badged by recipient like any other. A spectator, or a replay of
 * someone else's game, owns nobody, so this is broadcast or another player.
 */
export function messageBadge(
  entry: ChatEntry,
  players: RecordingHeader['players'] | undefined,
  ctx: AttributionContext,
  viewerPlayers: readonly string[],
): MessageBadge {
  if (entry.to === null) {
    return { variant: 'neutral', kind: 'broadcast' }
  }
  if (isViewerPlayer(entry.to, players, ctx, viewerPlayers)) {
    return { variant: 'accent', kind: 'to-you' }
  }
  return { variant: 'neutral', kind: 'to-player', playerId: entry.to }
}

/**
 * Whose a sender is, shown as the label's color: one of the viewer's own players, a player on the
 * viewer's side, or anyone else.
 */
export type SenderTone = 'own' | 'ally' | 'other'

/** How a message's sender reads: its label and its tone. */
export interface SenderIdentity {
  label: string
  tone: SenderTone
}

/**
 * A sender's label is its in-game name when the renderer reports one (`S0_cavalry_5`), otherwise the
 * shared attribution label. Ownership is carried by the tone (shown as color), not by the label, so it
 * survives the in-game name replacing "Your agent". A player is the viewer's own as `isViewerPlayer`
 * decides. A sender is an ally when the renderer
 * gives it the same team as one of the viewer's own players. A spectator owns nobody, so has no allies.
 */
export function senderIdentity(
  playerId: string,
  profiles: Readonly<Record<string, PlayerProfile>>,
  players: RecordingHeader['players'] | undefined,
  ctx: AttributionContext,
  viewerPlayers: readonly string[],
): SenderIdentity {
  const isOwn = (id: string): boolean => isViewerPlayer(id, players, ctx, viewerPlayers)
  const label = profiles[playerId]?.name ?? attributionLabel(playerId, players?.[playerId], ctx)
  if (isOwn(playerId)) {
    return { label, tone: 'own' }
  }
  const team = profiles[playerId]?.team
  const ownTeams = [...viewerPlayers, ...Object.keys(players ?? {})]
    .filter(isOwn)
    .map((id) => profiles[id]?.team)
  return { label, tone: team !== undefined && ownTeams.includes(team) ? 'ally' : 'other' }
}
