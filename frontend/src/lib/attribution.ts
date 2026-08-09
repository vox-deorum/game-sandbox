/**
 * The one place a player's attribution label is decided, so every surface that names "who or what drove
 * a player", the per-player attribution line and end-of-game leaderboard, reads identically and honours
 * the same blind policy. A human player names the user; an agent player shows its label, unless a non-
 * operator is viewing a playable season, when a submitted agent is anonymized to "Agent N"
 * (the viewer's own agent reads "Your agent" so they can still find themselves).
 */
import type { RecordingHeader } from '@game-sandbox/schema'

import { formatPlayer } from './format.js'

/** One entry of a recording header's `players` map. */
type Player = RecordingHeader['players'][string]

/** How a viewer sees attribution: blind hides submitted-agent ownership while a season is playable. */
export interface AttributionContext {
  /** Hide submitted-agent ownership while a non-operator views a playable season. */
  blind?: boolean
  /** Lets a blind viewer still recognize their own submitted agent. */
  viewerId?: string
  /** Submission id → season-wide anonymous number, matching the watch picker and rating panel. */
  anonymousNumbers?: Record<string, number>
}

/** A masked submission's compact pseudonym, shared by every frontend surface that names one. */
export function maskedSubmissionLabel(number?: number): string {
  return number === undefined ? 'Agent' : `Agent ${number}`
}

/** A blind submitted agent's label, numbered to match the watch picker and rating panel. */
function blindAgentLabel(submissionId: string, anonymousNumbers?: Record<string, number>): string {
  return maskedSubmissionLabel(anonymousNumbers?.[submissionId])
}

/**
 * Whether `player`'s row is the current viewer's own player: both ids must be defined and equal. An
 * anonymous viewer (`ctx.viewerId === undefined`) must never match a header entry that also carries no
 * `user` (schema-optional, absent on some agent players and on older recordings), `undefined ===
 * undefined` is not "the same person," so the exemption below fails closed rather than granting an
 * anonymous viewer somebody else's identity.
 */
function isOwnRow(player: Player, ctx: AttributionContext): boolean {
  const user = 'user' in player ? player.user : undefined
  return user !== undefined && user === ctx.viewerId
}

/**
 * Whether blind policy hides `player`'s identity from the current viewer: true for another player's
 * human or submitted agent while a season is playable, false for the viewer's own player (still shown,
 * relabeled "Your agent" for a submission, see `attributionLabel`, not hidden), and false whenever
 * blind does not apply at all. Exposed so a caller that also surfaces the stable id as a tooltip can
 * suppress it under the exact same test `attributionLabel` uses to decide the label, rather than
 * duplicating (and risking drifting from) that policy.
 */
export function isBlindMasked(player: Player, ctx: AttributionContext = {}): boolean {
  if (ctx.blind !== true) {
    return false
  }
  if (player.kind === 'human') {
    return !isOwnRow(player, ctx)
  }
  return 'submission_id' in player && !isOwnRow(player, ctx)
}

/** Whether a players map contains a submitted (non-builtin) agent player, the only case blind
 *  ownership masking has anything to protect. A player map with none (an all-human or all-Naive
 *  recording) needs no masking regardless of season state. */
export function hasSubmittedAgent(players: RecordingHeader['players'] | undefined): boolean {
  return Object.values(players ?? {}).some(
    (player) => player.kind === 'agent' && 'submission_id' in player,
  )
}

/**
 * The identity to show for `playerId`, given its header entry (absent on older recordings, a player
 * fallback) and the viewer's attribution context. The bare identity, with no "Human:" affordance —
 * a caller that wants to mark the kind adds its own prefix.
 */
export function attributionLabel(
  playerId: string,
  player: Player | undefined,
  ctx: AttributionContext = {},
): string {
  if (player === undefined) {
    return formatPlayer(playerId)
  }
  // A viewer's own submitted agent is never hidden (so isBlindMasked is false for it) but is relabeled
  // "Your agent" while blind, so they can still find themselves. This self-identification is the one
  // label decision that sits outside the hide policy.
  if (ctx.blind === true && player.kind === 'agent' && isOwnRow(player, ctx)) {
    return 'Your agent'
  }
  // Every other "hide this identity?" case goes through isBlindMasked, the single owner of the blind
  // policy, rather than re-deriving it here. Blind hides a human player's identity too, not just the
  // display name: public payloads already pair a submitted agent's user_id with its user_name, so an
  // opaque id would be trivially reversible to a name.
  if (isBlindMasked(player, ctx)) {
    // isBlindMasked is true for an agent only when it carries a submission_id, so the fallback is inert.
    return player.kind === 'human'
      ? 'Human'
      : blindAgentLabel('submission_id' in player ? player.submission_id : '', ctx.anonymousNumbers)
  }
  return player.label
}

/** The member order shared by a seat's label and stable-id tooltip: humans first, then recorded order. */
function orderedSeatMembers(
  members: readonly string[],
  attributions: RecordingHeader['players'] | undefined,
): string[] {
  return [...members].sort((a, b) => {
    const aHuman = attributions?.[a]?.kind === 'human'
    const bHuman = attributions?.[b]?.kind === 'human'
    return Number(bHuman) - Number(aHuman)
  })
}

/**
 * How one seat's controllers read wherever a seat is named. Humans lead mixed seats, and repeated
 * labels collapse so a wide seat controlled by one agent reads once rather than once per player.
 */
export function seatControllerLabel(
  members: readonly string[],
  attributions: RecordingHeader['players'] | undefined,
  ctx: AttributionContext = {},
): string {
  return [
    ...new Set(
      orderedSeatMembers(members, attributions).map((member) =>
        attributionLabel(member, attributions?.[member], ctx),
      ),
    ),
  ].join(', ')
}

/**
 * The stable user ids behind a seat's visible controller label. Blind-masked entries contribute no id,
 * and repeated ids collapse in the same order as the label's controller entries.
 */
export function seatControllerTitle(
  members: readonly string[],
  attributions: RecordingHeader['players'] | undefined,
  ctx: AttributionContext = {},
): string | undefined {
  const ids = orderedSeatMembers(members, attributions)
    .map((member) => attributions?.[member])
    .filter((player): player is Player => player !== undefined && !isBlindMasked(player, ctx))
    .map((player) => ('user' in player ? player.user : undefined))
    .filter((id): id is string => id !== undefined)
  const title = [...new Set(ids)].join(', ')
  return title === '' ? undefined : title
}
