/**
 * The shared launch-config seam: the one place that expands a per-seat assignment into the
 * `player_bindings` and `players` blocks of the session config the container reads.
 *
 * Two callers need this and must not drift. The {@link import('./orchestrator.js').Orchestrator} builds
 * a *live, browser-attached* session: it has human (`external`) players, a single optional submitted
 * agent, and Naive baselines filling the rest. The Stage 6.4 workflow runner builds a *headless
 * run-to-completion* match: every player is an agent (a submitted overlay or the Naive baseline), no
 * human, no socket. The differences are how each caller decides what fills a player; the mapping from
 * that decision to the wire shape — `external` vs `builtin-agent`, the path a submitted overlay loads
 * from, and the recording-header attribution — is identical, so it lives here once.
 *
 * The output shape is lockstep with `harness/live.py`'s `parse_config`/`_parse_players` and the
 * `recording-header.schema.json` `players` block; changing either side without the other breaks a run.
 */
import type { ResolvedLayout } from '@game-sandbox/schema/environment'

/**
 * Per-player attribution copied verbatim into the recording header, so a replay can name who or what
 * drove each player. Mirrors the `players` value shape in `recording-header.schema.json`.
 */
export interface PlayerAttribution {
  kind: 'human' | 'agent'
  label: string
  user?: string
  submission_id?: string
  builtin_name?: string
}

/** One player's binding in the session config argv: an external (human) source or a loaded agent. */
export interface PlayerConfig {
  kind: 'external' | 'builtin-agent'
  /** Where a `builtin-agent` player loads its code from; absent selects a staged built-in agent. */
  path?: string
  /** Stable built-in name when this binding uses the image's staged agent tree. */
  name?: string
}

/**
 * What fills one player, in caller-neutral terms: a connected human, the built-in Naive baseline, or a
 * submitted agent (which carries the overlay path its code was staged into and its owner attribution).
 * The optional display names are a launch-time snapshot resolved by the caller through the user
 * directory; `player.user` always keeps the stable id, and a missing name falls back to it.
 */
export type SeatBinding =
  | {
      driver: 'human'
      /**
       * The one player the person controls. Seat validation picks it (the first human-capable member
       * in declared order) and it travels here, so nothing downstream re-derives the choice.
       */
      playerId: string
      userId: string
      displayName?: string
      /**
       * Required for a wide human seat and used for every nonhuman player in that seat. Typed to the
       * agent drivers alone, so a human companion is unrepresentable rather than rejected at runtime.
       */
      companion?: AgentBinding
    }
  | AgentBinding

/** The seat drivers that load an agent, which is everything a companion is allowed to be. */
export type AgentBinding =
  | { driver: 'builtin'; name: string; label?: string }
  | { driver: 'submission'; submissionId: string; userId: string; path: string; ownerName?: string }

/** The two session-config blocks derived from a seat assignment, keyed by player id. */
export interface AssembledLaunch {
  playerBindings: Record<string, PlayerConfig>
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
 * Map a player-id to a seat assignment onto the `player_bindings` and `players` blocks of the session
 * config. A human player is driven by the transport (`external`); a built-in or submitted player is a
 * `builtin-agent`. The submitted one carries the overlay path its code loads from. Built-ins snapshot
 * both their stable name and label in the recording, so replay rendering never needs an environment
 * or season lookup.
 */
export function assembleLaunch(
  seats: ReadonlyMap<string, SeatBinding>,
  layout: ResolvedLayout,
): AssembledLaunch {
  const playerBindings: Record<string, PlayerConfig> = {}
  const players: Record<string, PlayerAttribution> = {}
  const expectedSeats = new Set(layout.seats.map((seat) => seat.seatId))
  for (const seatId of seats.keys()) {
    if (!expectedSeats.has(seatId)) throw new Error(`unexpected seat binding ${seatId}`)
  }
  for (const resolvedSeat of layout.seats) {
    const seat = seats.get(resolvedSeat.seatId)
    if (seat === undefined) throw new Error(`missing seat binding ${resolvedSeat.seatId}`)
    for (const playerId of resolvedSeat.players) {
      const binding = bindingFor(seat, resolvedSeat.seatId, resolvedSeat.players, playerId)
      addPlayer(playerBindings, players, playerId, binding)
    }
  }
  return { playerBindings, players }
}

/**
 * Which binding drives one player of a seat. An agent seat repeats its own binding across every
 * member; a human seat puts the person on the player it named and its companion on the rest. The
 * caller has already accepted the assignment, so the checks here are the ones expansion itself owns:
 * the named player must belong to this seat, and a seat wider than that player needs a companion.
 */
function bindingFor(
  seat: SeatBinding,
  seatId: string,
  members: readonly string[],
  playerId: string,
): SeatBinding {
  if (seat.driver !== 'human') return seat
  if (!members.includes(seat.playerId)) {
    throw new Error(`human seat ${seatId} names player ${seat.playerId} outside it`)
  }
  if (playerId === seat.playerId) return seat
  if (seat.companion === undefined) throw new Error(`wide human seat ${seatId} needs a companion`)
  return seat.companion
}

function addPlayer(
  playerBindings: Record<string, PlayerConfig>,
  players: Record<string, PlayerAttribution>,
  playerId: string,
  seat: SeatBinding,
): void {
  if (playerBindings[playerId] !== undefined)
    throw new Error(`duplicate player binding ${playerId}`)
  switch (seat.driver) {
    case 'human':
      playerBindings[playerId] = { kind: 'external' }
      players[playerId] = {
        kind: 'human',
        label: seat.displayName ?? seat.userId,
        user: seat.userId,
      }
      break
    case 'builtin':
      playerBindings[playerId] = { kind: 'builtin-agent', name: seat.name }
      players[playerId] = { kind: 'agent', builtin_name: seat.name, label: seat.label ?? seat.name }
      break
    case 'submission':
      playerBindings[playerId] = { kind: 'builtin-agent', path: seat.path }
      players[playerId] = {
        kind: 'agent',
        label: `${seat.ownerName ?? seat.userId}'s agent`,
        user: seat.userId,
        submission_id: seat.submissionId,
      }
      break
  }
}
