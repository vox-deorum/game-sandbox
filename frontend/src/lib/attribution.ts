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
    return player.user ?? player.label
  }
  if (ctx.blind && player.submission_id !== undefined) {
    return player.user === ctx.viewerId
      ? 'Your agent'
      : blindAgentLabel(player.submission_id, ctx.anonymousNumbers)
  }
  return player.label
}
