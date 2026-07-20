/**
 * The shared launch-config seam: the one place that turns a per-slot seat assignment into the
 * `slots` and `players` blocks of the session config the container reads.
 *
 * Two callers need this and must not drift. The {@link import('./orchestrator.js').Orchestrator} builds
 * a *live, browser-attached* session: it has human (`external`) slots, a single optional submitted
 * agent, and Naive baselines filling the rest. The Stage 6.4 workflow runner builds a *headless
 * run-to-completion* match: every slot is an agent (a submitted overlay or the Naive baseline), no
 * human, no socket. The differences are how each caller decides what fills a slot; the mapping from
 * that decision to the wire shape — `external` vs `builtin-agent`, the path a submitted overlay loads
 * from, and the recording-header attribution — is identical, so it lives here once.
 *
 * The output shape is lockstep with `harness/live.py`'s `parse_config`/`_parse_players` and the
 * `recording-header.schema.json` `players` block; changing either side without the other breaks a run.
 */

/**
 * Per-slot attribution copied verbatim into the recording header, so a replay can name who or what
 * drove each slot. Mirrors the `players` value shape in `recording-header.schema.json`.
 */
export interface PlayerAttribution {
  kind: 'human' | 'agent'
  label: string
  user?: string
  submission_id?: string
}

/** One slot's binding in the session config argv: an external (human) source or a loaded agent. */
export interface SlotConfig {
  kind: 'external' | 'builtin-agent'
  /** Where a `builtin-agent` slot loads its code from; absent means the image's default Naive agent. */
  path?: string
}

/**
 * What fills one slot, in caller-neutral terms: a connected human, the built-in Naive baseline, or a
 * submitted agent (which carries the overlay path its code was staged into and its owner attribution).
 * The optional display names are a launch-time snapshot resolved by the caller through the user
 * directory; `player.user` always keeps the stable id, and a missing name falls back to it.
 */
export type SeatBinding =
  | { driver: 'human'; userId: string; displayName?: string }
  | { driver: 'naive' }
  | { driver: 'submission'; submissionId: string; userId: string; path: string; ownerName?: string }

/** The two session-config blocks derived from a seat assignment, keyed by slot id. */
export interface AssembledSeats {
  slots: Record<string, SlotConfig>
  players: Record<string, PlayerAttribution>
}

/** The exact LLM block shared by live and workflow session argv. */
export interface LlmLaunchConfig {
  llm: {
    base_url: string
    tick_url: string
    inflight_url: string
    keys: Record<string, string>
  }
}

/**
 * Assemble the one harness-facing LLM shape. Keeping the internal URLs explicit is intentional: the
 * tick-marker and in-flight endpoints are not below the OpenAI-compatible `/v1` path, so callers
 * must never derive either from `base_url`. An empty key map is not useful and is represented by no
 * block at all.
 */
export function assembleLlmLaunchConfig(
  internalPort: number,
  keys: Readonly<Record<string, string>>,
): LlmLaunchConfig | Record<string, never> {
  if (Object.keys(keys).length === 0) {
    return {}
  }
  return {
    llm: {
      base_url: `http://llm-proxy:${internalPort}/v1`,
      tick_url: `http://llm-proxy:${internalPort}/internal/tick`,
      inflight_url: `http://llm-proxy:${internalPort}/internal/inflight`,
      keys: { ...keys },
    },
  }
}

/**
 * Map a slot-id → seat assignment onto the `slots` and `players` blocks of the session config. A
 * human slot is driven by the transport (`external`); a Naive or submitted slot is a `builtin-agent`,
 * the submitted one carrying the overlay path its code loads from. The attribution mirrors the seat:
 * the human's display name, the generic "Naive agent", or "<owner>'s agent" tagged with the
 * submission. `user` always carries the stable id; the label falls back to it when the caller
 * resolved no display name, so a recording stays attributable without joining mutable auth data.
 */
export function assembleSeats(seats: ReadonlyMap<string, SeatBinding>): AssembledSeats {
  const slots: Record<string, SlotConfig> = {}
  const players: Record<string, PlayerAttribution> = {}
  for (const [slotId, seat] of seats) {
    switch (seat.driver) {
      case 'human':
        slots[slotId] = { kind: 'external' }
        players[slotId] = {
          kind: 'human',
          label: seat.displayName ?? seat.userId,
          user: seat.userId,
        }
        break
      case 'naive':
        slots[slotId] = { kind: 'builtin-agent' }
        players[slotId] = { kind: 'agent', label: 'Naive agent' }
        break
      case 'submission':
        slots[slotId] = { kind: 'builtin-agent', path: seat.path }
        players[slotId] = {
          kind: 'agent',
          label: `${seat.ownerName ?? seat.userId}'s agent`,
          user: seat.userId,
          submission_id: seat.submissionId,
        }
        break
    }
  }
  return { slots, players }
}
