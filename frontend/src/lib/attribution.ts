/**
 * The one place a slot's attribution label is decided, so every surface that names "who or what drove
 * a slot" — the per-slot attribution line, the end-of-game leaderboard — reads identically and honours
 * the same blind policy. A human slot names the user; an agent slot shows its label, unless a non-
 * operator is viewing a playable season, when a submitted agent is anonymized to "Submitted agent N"
 * (the viewer's own agent reads "Your agent" so they can still find themselves).
 */
import type { RecordingHeader } from '@game-sandbox/schema'

import { formatSlot } from './format.js'

/** One entry of a recording header's `players` map. */
type Player = NonNullable<RecordingHeader['players']>[string]

/** How a viewer sees attribution: blind hides submitted-agent ownership while a season is playable. */
export interface AttributionContext {
  /** Hide submitted-agent ownership while a non-operator views a playable season. */
  blind?: boolean
  /** Lets a blind viewer still recognize their own submitted agent. */
  viewerId?: string
  /** Submission id → season-wide anonymous number, matching the watch picker and rating panel. */
  anonymousNumbers?: Record<string, number>
}

/** A blind submitted agent's label, numbered to match the watch picker and rating panel. */
function blindAgentLabel(submissionId: string, anonymousNumbers?: Record<string, number>): string {
  const number = anonymousNumbers?.[submissionId]
  return number === undefined ? 'Submitted agent' : `Submitted agent ${number}`
}

/**
 * Whether `player`'s row is the current viewer's own seat: both ids must be defined and equal. An
 * anonymous viewer (`ctx.viewerId === undefined`) must never match a header entry that also carries no
 * `user` (schema-optional, absent on some agent slots and on older recordings) — `undefined ===
 * undefined` is not "the same person," so the exemption below fails closed rather than granting an
 * anonymous viewer somebody else's identity.
 */
function isOwnRow(player: Player, ctx: AttributionContext): boolean {
  return player.user !== undefined && player.user === ctx.viewerId
}

/**
 * Whether blind policy hides `player`'s identity from the current viewer: true for another seat's
 * human or submitted agent while a season is playable, false for the viewer's own seat (still shown —
 * relabeled "Your agent" for a submission, see `attributionLabel` — not hidden), and false whenever
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
  return player.submission_id !== undefined && !isOwnRow(player, ctx)
}

/** Whether a players map contains a submitted (non-builtin) agent slot — the only case blind
 *  ownership masking has anything to protect. A slot map with none (an all-human or all-Naive
 *  recording) needs no masking regardless of season state. */
export function hasSubmittedAgent(players: RecordingHeader['players'] | undefined): boolean {
  return Object.values(players ?? {}).some(
    (player) => player.kind === 'agent' && player.submission_id !== undefined,
  )
}

/**
 * The identity to show for `slot`, given its header entry (absent on older recordings → a slot
 * fallback) and the viewer's attribution context. The bare identity, with no "Human:" affordance —
 * a caller that wants to mark the kind adds its own prefix.
 */
export function attributionLabel(
  slot: string,
  player: Player | undefined,
  ctx: AttributionContext = {},
): string {
  if (player === undefined) {
    return formatSlot(slot)
  }
  if (player.kind === 'human') {
    // Blind hides a human seat's identity too, not just the display name: public leaderboard payloads
    // already pair a submitted agent's user_id with its user_name, so an opaque id here would be
    // trivially reversible to a name. This is deliberately stricter than showing the bare id.
    return isBlindMasked(player, ctx) ? 'Human' : (player.label ?? player.user)
  }
  if (ctx.blind && player.submission_id !== undefined) {
    return isOwnRow(player, ctx)
      ? 'Your agent'
      : blindAgentLabel(player.submission_id, ctx.anonymousNumbers)
  }
  return player.label
}
