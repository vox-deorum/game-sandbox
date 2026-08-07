/**
 * The pure, game-agnostic half of a trick-taking card renderer: the parts every four-player card game
 * (Hearts, Spades) lays out identically — the card codec, the felt palette, the player/trick/hand/opponent
 * geometry, the legal-mask-driven hand fan, the hit-test, and the pure animation helpers (the card-play
 * fly-in and the trick-won sweep). A game module composes these builders and adds only its own overlay
 * fields, player content, and status strip. No canvas and no accumulated history, so it is unit-testable in
 * plain Vitest (jsdom has no canvas) and the contract's determinism rule holds: the same state (plus the
 * mount-time config) always yields the same scene, which is what the replay scrubber depends on.
 *
 * This is the canonical shared scene layer for browser rendering and local browser play. Both Hearts
 * and Spades consume the same semantic overlays and geometry from this module.
 *
 * The animations (the card-play fly-in and the trick-won sweep) are intentionally *not* baked into the
 * scene: a transition is a function of the move *between* two states, not of one state, so it would break
 * the same-state-same-scene rule. {@link detectPlay}/{@link detectSweep} and the `*At` easing helpers are
 * pure functions the retained renderer drives from its own clock; a game's `computeScene` always returns
 * the static "snapped" frame a scrubber lands on.
 */
import type { RecordingHeader, StepState } from '@game-sandbox/schema'

import { formatPlayer, formatSeat } from '../../lib/format.js'

// --- Card encoding (mirrors environments/local_play/card_utils.py) ---
// A card OBJECT is `{suit, rank}`: suits 0=clubs, 1=diamonds, 2=spades, 3=hearts; rank is the FACE
// value 2..14 (jack 11, queen 12, king 13, ace 14) — the value printed on the card, not the engine's
// 0-indexed rank. The engine (integer) card id 0..51 is `suit * 13 + (rank - 2)`; that encoding is used
// ONLY at the browser's send boundary (`cardToAction`), never in scene state, drawing, or legality.
export const CLUBS = 0
export const DIAMONDS = 1
export const SPADES = 2
export const HEARTS = 3
export const NUM_PLAYERS = 4

/** One playing card: suit 0..3, rank the FACE value 2..14 (mirrors card_utils.card_to_obj). */
export interface Card {
  suit: number
  rank: number
}

/** A stable, unique string identity for a card, for Sets/Maps and animation matching across frames. */
export function cardKey(card: Card): string {
  return `${card.suit}:${card.rank}`
}

/** The engine's integer card id 0..51 (`suit*13 + rank_index`), the value sent to the server. This is
 *  the ONLY place a Card becomes an int; every other reader (scene, drawing, legality) stays object. */
export function cardToAction(card: Card): number {
  return card.suit * 13 + (card.rank - 2)
}

/** Rank labels indexed by rank id 0..12. */
export const RANK_LABELS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
  'A',
] as const

/** The display label for a card's face rank (e.g. 'A' for rank 14, 'J' for rank 11). */
export function rankLabel(card: Card): string {
  return RANK_LABELS[card.rank - 2] ?? '?'
}

// --- Fixed frame and card dimensions ---
export const WIDTH = 960
export const HEIGHT = 720
/** Card-face dimensions for the view player's fanned hand. */
export const CARD_W = 64
export const CARD_H = 92
/** Smaller card-face dimensions for trick cards and revealed opponent hands. */
export const SMALL_W = 48
export const SMALL_H = 70

const HAND_MARGIN = 40
const HAND_CARD_GAP = 6

/** The horizontal start and step for the view player's fanned hand. */
export function handFanGeometry(count: number): { startX: number; step: number } {
  const availableWidth = WIDTH - 2 * HAND_MARGIN
  const step =
    count > 1
      ? Math.min(CARD_W + HAND_CARD_GAP, Math.floor((availableWidth - CARD_W) / (count - 1)))
      : 0
  const run = step * (count - 1) + CARD_W
  return { startX: Math.floor((WIDTH - run) / 2), step }
}

/**
 * Flat-color palette (RGB hex). Renderer modules are the one place raw color literals are allowed
 * because a renderer owns its game's visual identity.
 */
export const COLORS = {
  feltTop: '#14744a',
  feltBottom: '#073c26',
  wellRing: '#2c9666',
  gold: '#ecc870',
  goldDim: '#967c3c',
  cardFace: '#f9f7f0',
  cardEdge: '#d0ccc0',
  cardBack: '#203a82',
  cardBackDark: '#14265c',
  cardBackTrim: '#ced6f0',
  cardBackGold: '#d0b060',
  redInk: '#c41c26',
  blackInk: '#1a1a20',
  white: '#f2f2f0',
  dim: '#b2beb8',
  hintInk: '#d2ded8',
  badgeBg: '#0f3a27',
  badgeBgYou: '#144c35',
  badgeShadow: '#032015',
  legalBorder: '#5ee284',
  winnerGlow: '#ecc870',
  // The grey veil over an illegal card, with its alpha kept separate.
  greyVeil: '#26322c',
  greyVeilAlpha: 168 / 255,
} as const

/**
 * Shared wide-seat accent colors: the source both the assignment-seat tab beside a player badge and
 * Spades' two-team score tint draw from, so the two can never fall out of sync. They repeat for a
 * layout with more than four wide seats.
 */
export const WIDE_SEAT_TINTS = ['#6cc4ec', '#ec9c78', '#b7d67a', '#d2a8ff'] as const

/** The center of the table, where the trick is laid out. */
export const TRICK_CENTER = { x: WIDTH / 2, y: HEIGHT / 2 }

// --- Per-game table geometry ---

/**
 * The handful of table measurements a game varies. They are threaded through the geometry helpers so
 * Hearts uses the defaults and Spades passes its own without duplicating layout code.
 */
export interface TableGeometry {
  /** The y of the North player badge center. */
  northBadgeY: number
  /** The y of the North opponent card row. */
  opponentRowNorthY: number
  /** Player badge width. */
  badgeW: number
  /** Player badge height. */
  badgeH: number
  /** How far the West and East player badges sit in from the side edges. */
  sideBadgeInset: number
}

/** The Hearts geometry, used as the shared default. */
export const DEFAULT_GEOMETRY: TableGeometry = {
  northBadgeY: 101,
  opponentRowNorthY: 150,
  badgeW: 158,
  badgeH: 56,
  sideBadgeInset: 130,
}

// --- Scene shapes the retained renderer (CardTableRenderer) reconciles toward ---

/** The game-agnostic core of a player badge; a game extends it with score or bid and won fields. */
export interface ScenePlayerBase {
  player: number
  /** Screen position 0=South (view), 1=West, 2=North, 3=East. */
  position: number
  x: number
  y: number
  /** The wide assignment seat this player shares, or null for a singleton seat. */
  assignmentSeat: string | null
  /** Stable wide-seat order, used to choose the shared grouping cue's color. */
  assignmentGroup: number | null
  label: string
  /** Whose turn it is now (gold highlight); false at terminal. */
  isTurn: boolean
  /** Whether the user controls this player in live play. */
  isYou: boolean
}

/** A face-up card in the central trick, positioned at its player's screen-position offset. */
export interface SceneTrickCard {
  player: number
  card: Card
  x: number
  y: number
  /** Highlighted gold when this scene shows a completed trick and this card won it. */
  isWinner: boolean
}

/** A small card in a non-view player's row. */
export interface SceneCard {
  player: number
  card: Card
  x: number
  y: number
  w: number
  h: number
  faceUp: boolean
  /** Whether the viewer controls the player whose row contains this card. */
  controlled: boolean
  /** Playable now: the viewer controls this row's player, it is that player's turn, and the card is legal. */
  legal: boolean
  /** Clickable: playable now, and the hand is still running. */
  controllable: boolean
}

/** One card in the view player's fanned hand. */
export interface SceneHandCard {
  card: Card
  x: number
  y: number
  w: number
  h: number
  /** In the emitted legal-cards set for the current turn: drawn lit and raised; else greyed. */
  legal: boolean
  /** Clickable: legal, it is the view player's turn, and the user controls the view player. */
  controllable: boolean
}

/** The active move-clock chip: shown only on the controlled human's turn (hidden in replay/spectate). */
export interface SceneMoveClock {
  x: number
  y: number
  /** The per-move budget in milliseconds, from the session's `human_timeout_ms`. */
  totalMs: number
}

/** The game-agnostic core of one static frame; a game's scene extends it with its own status fields. */
export interface CardTableScene<TPlayer extends ScenePlayerBase = ScenePlayerBase> {
  width: number
  height: number
  viewPlayer: number
  revealAll: boolean
  terminal: boolean
  players: TPlayer[]
  trick: SceneTrickCard[]
  opponents: SceneCard[]
  hand: SceneHandCard[]
  moveClock: SceneMoveClock | null
}

/** Mount-time facts the scene needs beyond the state, kept out so a `computeScene` stays pure. */
export interface SceneConfig {
  /** The stable player ids this user controls; empty when spectating or replaying (then we reveal all hands). */
  controlledPlayers?: readonly string[]
  /** The session's human move-clock budget in ms (meta.human_timeout_ms or its override). */
  humanTimeoutMs?: number | null
  /** The recording or live-session seat map, used to group players sharing a wide assignment. */
  seats?: RecordingHeader['seats']
}

/** One play in a trick: who played (player) and what (a card object), in play order. */
export interface TrickEntry {
  player: number
  card: Card
}

/** The normalized, fully-defaulted core of the overlay every card game reads (snake_case from Python). */
export interface CardOverlay {
  hands: Card[][]
  currentTrick: TrickEntry[]
  lastTrick: TrickEntry[] | null
  lastTrickWinner: number | null
  turn: number
  turnPlayerId: string
  trickLeader: number
  ledSuit: number | null
  tricksPlayed: number
  legalCards: Card[]
  terminal: boolean
}

// --- Geometry helpers (pure, exported so the sweep math and the renderer share one source) ---

/** Map an absolute player to a screen position (0=S,1=W,2=N,3=E) with the view player at South. */
export function positionOfPlayer(player: number, viewPlayer: number): number {
  return (((player - viewPlayer) % NUM_PLAYERS) + NUM_PLAYERS) % NUM_PLAYERS
}

/** The (x, y) center of the player badge for a screen position. */
export function positionAnchor(
  position: number,
  geom: TableGeometry = DEFAULT_GEOMETRY,
): {
  x: number
  y: number
} {
  switch (position) {
    case 0:
      return { x: WIDTH / 2, y: HEIGHT - 150 } // South (view player)
    case 1:
      return { x: geom.sideBadgeInset, y: HEIGHT / 2 } // West
    case 2:
      return { x: WIDTH / 2, y: geom.northBadgeY } // North (below the status strip)
    default:
      return { x: WIDTH - geom.sideBadgeInset, y: HEIGHT / 2 } // East
  }
}

/** The center offset (dx, dy) for a card played from a screen position. */
export function trickOffset(position: number): { dx: number; dy: number } {
  switch (position) {
    case 0:
      return { dx: 0, dy: 80 }
    case 1:
      return { dx: -90, dy: 0 }
    case 2:
      return { dx: 0, dy: -80 }
    default:
      return { dx: 90, dy: 0 }
  }
}

/** The player index for a stable id like "player_2" (mirrors env.possible_agents ordering). */
export function playerOfId(playerId: string): number {
  const match = /(\d+)$/.exec(playerId)
  return match ? Number(match[1]) : 0
}

// --- Overlay normalization ---

/** Validate and normalize one raw `{"suit","rank"}` value into a Card, without re-encoding it. */
export function asCard(value: unknown): Card | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const v = value as Record<string, unknown>
  if (typeof v.suit !== 'number' || typeof v.rank !== 'number') {
    return null
  }
  return { suit: v.suit, rank: v.rank }
}

/** Validate and normalize a raw array of card objects into `Card[]`, dropping anything malformed. */
export function asCards(value: unknown): Card[] {
  if (!Array.isArray(value)) {
    return []
  }
  const cards: Card[] = []
  for (const raw of value) {
    const card = asCard(raw)
    if (card !== null) {
      cards.push(card)
    }
  }
  return cards
}

/** Validate and normalize a raw array of `{"player","card"}` entries into `TrickEntry[]` (play order). */
export function asCardEntries(value: unknown): TrickEntry[] {
  if (!Array.isArray(value)) {
    return []
  }
  const entries: TrickEntry[] = []
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') {
      continue
    }
    const v = raw as Record<string, unknown>
    const card = asCard(v.card)
    if (typeof v.player === 'number' && card !== null) {
      entries.push({ player: v.player, card })
    }
  }
  return entries
}

export function asNumberList(value: unknown): number[] {
  return Array.isArray(value) ? value.map((v) => Number(v)) : []
}

/** Pad a per-player number array out to all four players, defaulting missing entries to 0. */
export function padScores(scores: number[]): number[] {
  return Array.from({ length: NUM_PLAYERS }, (_, i) => scores[i] ?? 0)
}

/**
 * Normalize the shared core of the open-typed overlay into a safe, fully-defaulted shape (an absent
 * overlay degrades to empty). A game reads this and adds its own fields (Hearts' `heartsBroken`, Spades'
 * `bids`/`phase`) on top.
 */
export function readCardOverlay(state: StepState): CardOverlay {
  const o = (state.overlay ?? {}) as Record<string, unknown>
  const rawHands = Array.isArray(o.hands) ? o.hands : []
  const hands: Card[][] = Array.from({ length: NUM_PLAYERS }, (_, player) =>
    asCards(rawHands[player]),
  )
  const ledSuit = o.led_suit
  return {
    hands,
    currentTrick: asCardEntries(o.current_trick),
    lastTrick: o.last_trick == null ? null : asCardEntries(o.last_trick),
    lastTrickWinner: o.last_trick_winner == null ? null : Number(o.last_trick_winner),
    turn: Number(o.turn ?? 0),
    turnPlayerId:
      typeof o.turn_player === 'string' ? o.turn_player : `player_${Number(o.turn ?? 0)}`,
    trickLeader: Number(o.trick_leader ?? 0),
    ledSuit: ledSuit == null ? null : Number(ledSuit),
    tricksPlayed: Number(o.tricks_played ?? 0),
    legalCards: asCards(o.legal_cards),
    terminal: Boolean(o.terminal),
  }
}

// --- View resolution (which player sits at the bottom, and whether opponents are revealed) ---

/**
 * The resolved viewing context for one scene: which player sits at the bottom, which players the user
 * controls, and whether to reveal every hand. The crucial split is `viewPlayer` vs `controlledPlayers`:
 * layout (the bottom player, the fanned hand) keys off `viewPlayer`, while anything that speaks in the
 * first person or accepts input (the "(you)" tag, "Your turn", the rule hint, the move clock,
 * clickability) keys off `controlledPlayers`. A spectator or replay has no controlled players, so none
 * of that first-person language leaks even though a player still sits at the bottom.
 */
export interface ViewContext {
  viewPlayer: number
  controlledPlayers: readonly number[]
  revealAll: boolean
}

/** Whether one table player is controlled by the connected viewer. */
export function isControlled(view: ViewContext, player: number): boolean {
  return view.controlledPlayers.includes(player)
}

/**
 * Resolve the {@link ViewContext} from the mount config.
 *
 * The recorded overlay always carries all four hands. In live human play the first stable controlled
 * player id sits at the bottom, and any additional controlled hands remain at their table positions.
 * Uncontrolled opponents are face-down. With no controlled ids (a spectator watching, or a replay), reveal every hand, default
 * the view to player 0, and leave `controlledPlayers` empty. The "(you)" marker and first-person status
 * follow real control rather than always tagging the bottom player, since a replay's bottom player is not
 * the viewer.
 */
export function resolveView(config: SceneConfig): ViewContext {
  const controlled = config.controlledPlayers ?? []
  if (controlled.length === 0) {
    return { viewPlayer: 0, controlledPlayers: [], revealAll: true }
  }
  const players = controlled.map(playerOfId)
  return { viewPlayer: players[0] as number, controlledPlayers: players, revealAll: false }
}

/** One non-singleton assignment seat and its stable display order. */
export interface WideSeatAssignment {
  seat: string
  group: number
}

/** Map only non-singleton assignment seats onto their member players. */
export function wideSeatAssignments(seats: SceneConfig['seats']): Map<string, WideSeatAssignment> {
  const assignments = new Map<string, WideSeatAssignment>()
  if (seats === undefined) {
    return assignments
  }
  Object.entries(seats)
    .filter(([, players]) => players.length > 1)
    .forEach(([seat, players], group) => {
      for (const player of players) {
        assignments.set(player, { seat, group })
      }
    })
  return assignments
}

/**
 * Accessible description of the wide assignment seats, absent when every seat is a singleton. Its
 * groups come straight from {@link wideSeatAssignments}, the same map the badge-tint grouping reads, so
 * the two can never disagree about which seats are wide or what order they list in.
 */
export function wideSeatsAccessibilityLabel(
  displayName: string,
  seats: SceneConfig['seats'],
): string | null {
  const assignments = wideSeatAssignments(seats)
  if (assignments.size === 0) {
    return null
  }
  const bySeat = new Map<string, string[]>()
  for (const [player, { seat }] of assignments) {
    const players = bySeat.get(seat)
    if (players === undefined) {
      bySeat.set(seat, [player])
    } else {
      players.push(player)
    }
  }
  const details = [...bySeat]
    .map(
      ([seat, players]) =>
        `${formatSeat(seat)} includes ${players.map(formatPlayer).join(' and ')}`,
    )
    .join('; ')
  return `${displayName} table. Wide seats: ${details}.`
}

// --- The shared scene builders (a game composes these in its own computeScene) ---

/**
 * The geometric core of the four player badges: player, screen position, badge center, "(you)"-aware label,
 * and the active-turn flag. A game maps over these to add its own per-player
 * fields (Hearts' running score, Spades' bid/won and team).
 */
export function buildPlayersBase(
  o: CardOverlay,
  view: ViewContext,
  geom: TableGeometry,
  seats?: SceneConfig['seats'],
): ScenePlayerBase[] {
  const assignments = wideSeatAssignments(seats)
  return Array.from({ length: NUM_PLAYERS }, (_, player) => {
    const position = positionOfPlayer(player, view.viewPlayer)
    const { x, y } = positionAnchor(position, geom)
    // "(you)" tags every player the user controls. No player matches while spectating or replaying,
    // even though one player still sits at the bottom.
    const isYou = isControlled(view, player)
    const assignment = assignments.get(`player_${player}`)
    const playerLabel = isYou ? `P${player} (you)` : `P${player}`
    return {
      player,
      position,
      x,
      y,
      assignmentSeat: assignment?.seat ?? null,
      assignmentGroup: assignment?.group ?? null,
      label:
        assignment === undefined ? playerLabel : `${formatSeat(assignment.seat)} · ${playerLabel}`,
      isTurn: !o.terminal && player === o.turn,
      isYou,
    }
  })
}

/**
 * Place a list of `{player, card}` trick entries at their screen-position offsets around the table center,
 * flagging the winner (if any). Shared by {@link buildTrick} and the play fly-in's "resting" cards so
 * the static center cards and the animated ones agree on geometry to the pixel.
 */
function placeTrickCards(
  entries: ReadonlyArray<TrickEntry>,
  viewPlayer: number,
  winner: number | null,
): SceneTrickCard[] {
  return entries.map(({ player, card }) => {
    const { dx, dy } = trickOffset(positionOfPlayer(player, viewPlayer))
    return {
      player,
      card,
      x: TRICK_CENTER.x + dx,
      y: TRICK_CENTER.y + dy,
      isWinner: winner !== null && player === winner,
    }
  })
}

/**
 * Build the central trick. While a trick is in progress we show its cards; between tricks we show the
 * just-completed trick with its winner highlighted, so a scrubber
 * landing on the completion frame still sees what was played. The retained renderer animates the sweep on
 * top. Returns the trick cards and who won (null while in progress) for the caller's status message.
 */
export function buildTrick(
  o: CardOverlay,
  viewPlayer: number,
): { trick: SceneTrickCard[]; trickWinner: number | null } {
  let entries: ReadonlyArray<TrickEntry> = o.currentTrick
  let winner: number | null = null
  if (entries.length === 0) {
    if (o.lastTrick === null) {
      return { trick: [], trickWinner: null }
    }
    entries = o.lastTrick
    winner = o.lastTrickWinner
  }
  return { trick: placeTrickCards(entries, viewPlayer, winner), trickWinner: winner }
}

/** Lay out the three non-view players' cards along their table edges. */
export function buildOpponents(
  o: CardOverlay,
  view: ViewContext,
  legalKeys: ReadonlySet<string>,
  geom: TableGeometry,
): SceneCard[] {
  const cards: SceneCard[] = []
  for (let player = 0; player < NUM_PLAYERS; player++) {
    if (player === view.viewPlayer) {
      continue
    }
    const position = positionOfPlayer(player, view.viewPlayer)
    const hand = o.hands[player] ?? []
    const count = hand.length
    if (count === 0) {
      continue
    }
    const vertical = position === 1 || position === 3 // West / East sit along the side edges.
    const span = (vertical ? HEIGHT : WIDTH) - 360
    const step = count > 1 ? Math.min(SMALL_W - 14, Math.floor(span / count)) : 0
    const run = step * (count - 1) + SMALL_W
    for (let i = 0; i < count; i++) {
      let x: number
      let y: number
      if (vertical) {
        x = position === 1 ? 36 : WIDTH - 36 - SMALL_W
        y = Math.floor((HEIGHT - run) / 2) + i * step
      } else {
        x = Math.floor((WIDTH - run) / 2) + i * step
        y = geom.opponentRowNorthY // North row sits just under the top player badge.
      }
      const card = hand[i] as Card
      const controlled = isControlled(view, player)
      const legal = controlled && player === o.turn && legalKeys.has(cardKey(card))
      cards.push({
        player,
        card,
        x,
        y,
        w: SMALL_W,
        h: SMALL_H,
        faceUp: view.revealAll || controlled,
        controlled,
        legal,
        controllable: legal && !o.terminal,
      })
    }
  }
  return cards
}

/**
 * Fan the view player's hand across the bottom, marking each card legal (lit and raised) or illegal
 * (greyed). Legality reads the passed `legalKeys` set of {@link cardKey} identities — which the game
 * derives verbatim from the emitted `legal_cards` overlay, so the browser never recomputes the rules;
 * the set is the current turn's,
 * so a card lights only when it is the view player's turn. A card is clickable when it is legal, it is the
 * view player's turn, and the user controls that player.
 */
export function buildHand(
  o: CardOverlay,
  view: ViewContext,
  legalKeys: ReadonlySet<string>,
): SceneHandCard[] {
  const hand = o.hands[view.viewPlayer] ?? []
  const count = hand.length
  if (count === 0) {
    return []
  }
  // Clickable only when the user controls the player shown at the bottom and it is that player's turn;
  // No player is controlled when spectating or replaying, leaving the whole hand inert and draw-only.
  const controllableTurn =
    isControlled(view, view.viewPlayer) && !o.terminal && o.turn === view.viewPlayer

  const { startX, step } = handFanGeometry(count)
  const baseY = HEIGHT - CARD_H - 18

  return hand.map((card, i) => {
    const legal = legalKeys.has(cardKey(card))
    return {
      card,
      x: startX + i * step,
      // Raise legal cards a few pixels so they read as selectable.
      y: baseY - (legal ? 10 : 0),
      w: CARD_W,
      h: CARD_H,
      legal,
      controllable: legal && controllableTurn,
    }
  })
}

/** How far (px) the move clock sits from the acting player's badge, toward the table centre. */
const CLOCK_INSET = 56

/**
 * The move-clock chip, shown only when it is the turn of a player this user controls and the hand is not
 * over. That condition is empty in a replay or a spectator view (no controlled player ids), so the clock is
 * naturally hidden there, satisfying "show the move clock live, hide it in replay". The scene carries the
 * budget, which is a pure function of the state; the countdown itself comes from the renderer's
 * {@link MoveClock}, since elapsed time is not part of any frame.
 */
export function buildMoveClock(
  o: CardOverlay,
  view: ViewContext,
  humanTimeoutMs: number | null | undefined,
  geom: TableGeometry = DEFAULT_GEOMETRY,
): SceneMoveClock | null {
  if (o.terminal || humanTimeoutMs == null || humanTimeoutMs <= 0) {
    return null
  }
  if (!isControlled(view, o.turn)) {
    return null
  }
  const position = positionOfPlayer(o.turn, view.viewPlayer)
  const anchor = positionAnchor(position, geom)
  // Sit the chip one badge-height toward the table centre from the acting player's badge, so it follows
  // the acting hand around the table without covering the badge. The side badges are centred
  // vertically, so those shift horizontally instead.
  const sideways = position === 1 || position === 3
  const x = sideways ? anchor.x + (anchor.x < WIDTH / 2 ? CLOCK_INSET : -CLOCK_INSET) : anchor.x
  const y = sideways ? anchor.y : anchor.y + (anchor.y < HEIGHT / 2 ? CLOCK_INSET : -CLOCK_INSET)
  return { x, y, totalMs: humanTimeoutMs }
}

// --- Hit-testing ---

/**
 * The hand card under a point in internal (960x720) coordinates, or null if none. Hand cards overlap,
 * so the rects are scanned in reverse draw order (the visually front-most / right-most card first), as
 * in the fan. Legality is ignored here; the caller decides whether to accept the click.
 */
export function handCardAt(
  hand: readonly SceneHandCard[],
  x: number,
  y: number,
): SceneHandCard | null {
  for (let i = hand.length - 1; i >= 0; i--) {
    const c = hand[i] as SceneHandCard
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) {
      return c
    }
  }
  return null
}

// --- The trick-won sweep animation (pure helpers the retained renderer drives from its clock) ---

/** One card sliding into the winner's player badge during the sweep. */
export interface SweepCard {
  player: number
  card: Card
  fromX: number
  fromY: number
}

/** Everything the sweep needs: the four cards, the winner's anchor, and who won. */
export interface TrickSweep {
  cards: SweepCard[]
  toX: number
  toY: number
  winner: number
}

/**
 * Detect a just-completed trick by comparing the previously rendered state to the new one: the trick
 * count went up and the new state carries a completed `last_trick`. Returns the sweep description (the
 * four cards at their center positions, sliding to the winner's player badge) or null when nothing was swept.
 * Pure, so the renderer can decide to animate without holding any hidden state of its own. A game may
 * layer its own flourish (a points/contract pill) on top from the returned `cards` and `winner`.
 */
export function detectSweep(
  prev: StepState | null,
  next: StepState,
  viewPlayer: number,
  geom: TableGeometry = DEFAULT_GEOMETRY,
): TrickSweep | null {
  const n = readCardOverlay(next)
  if (n.lastTrick === null || n.lastTrickWinner === null || n.currentTrick.length !== 0) {
    return null
  }
  const prevPlayed = prev === null ? -1 : readCardOverlay(prev).tricksPlayed
  if (n.tricksPlayed <= prevPlayed) {
    return null
  }
  const winnerAnchor = positionAnchor(positionOfPlayer(n.lastTrickWinner, viewPlayer), geom)
  const cards: SweepCard[] = n.lastTrick.map(({ player, card }) => {
    const { dx, dy } = trickOffset(positionOfPlayer(player, viewPlayer))
    return { player, card, fromX: TRICK_CENTER.x + dx, fromY: TRICK_CENTER.y + dy }
  })
  return { cards, toX: winnerAnchor.x, toY: winnerAnchor.y, winner: n.lastTrickWinner }
}

/** Clamp `t` to [0,1] and apply the classic smoothstep ease. */
export function smoothstep(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return c * c * (3 - 2 * c)
}

/**
 * The position and scale of one swept card at progress `t` in [0,1]. The first `HOLD` fraction holds
 * the cards in place (the winner's card pulses), then they slide and shrink into the winner's player badge
 * using a 0.34 hold fraction and a `1 - 0.7 * move` scale.
 */
export const SWEEP_HOLD = 0.34
export function sweepCardAt(
  card: SweepCard,
  sweep: TrickSweep,
  t: number,
): { x: number; y: number; scale: number } {
  const move = t < SWEEP_HOLD ? 0 : smoothstep((t - SWEEP_HOLD) / (1 - SWEEP_HOLD))
  return {
    x: card.fromX + (sweep.toX - card.fromX) * move,
    y: card.fromY + (sweep.toY - card.fromY) * move,
    scale: 1 - 0.7 * move,
  }
}

// --- The card-play fly-in animation (pure helpers the retained renderer drives from its clock) ---

/**
 * One card flying from the player who just played it into its resting spot in the central trick. The
 * source is where the card was drawn in the *previous* frame (the player's fanned hand, or an
 * opponent's row), so the flyer leaves exactly where the eye last saw the card. `resting` is the cards
 * already in the center before this play; `completesTrick` is true when this play was a trick's fourth
 * card (which resolves the trick in the same step), telling the renderer to chain into the sweep.
 */
export interface PlayMove {
  player: number
  card: Card
  fromX: number
  fromY: number
  fromW: number
  fromH: number
  toX: number
  toY: number
  resting: SceneTrickCard[]
  completesTrick: boolean
}

/**
 * Detect a single card play by comparing the previously rendered state to the new one: either one new
 * pair was appended to the in-progress trick (cards 1–3), or the trick count went up and the new card
 * shows only in the completed `last_trick` (the 4th card, which resolves the trick in the same step,
 * see rules.play). Returns the fly-in description, or null when nothing was newly played (no change, a
 * fresh deal, a backward scrub). Pure, so the renderer animates without holding hidden state.
 */
export function detectPlay(
  prev: StepState | null,
  next: StepState,
  viewPlayer: number,
  geom: TableGeometry = DEFAULT_GEOMETRY,
): PlayMove | null {
  if (prev === null) {
    return null
  }
  const p = readCardOverlay(prev)
  const n = readCardOverlay(next)

  let player: number
  let card: Card
  let completesTrick: boolean
  if (n.tricksPlayed === p.tricksPlayed && n.currentTrick.length === p.currentTrick.length + 1) {
    // Cards 1–3: one new entry appended to the same in-progress trick.
    const entry = n.currentTrick[n.currentTrick.length - 1]
    if (entry === undefined) {
      return null
    }
    ;({ player, card } = entry)
    completesTrick = false
  } else if (
    n.currentTrick.length === 0 &&
    n.lastTrick !== null &&
    n.tricksPlayed === p.tricksPlayed + 1
  ) {
    // The 4th card resolved the trick in one step, so it only appears in last_trick now: it is the
    // last_trick card that was not already resting in the previous in-progress trick.
    const resting = new Set(p.currentTrick.map((e) => cardKey(e.card)))
    const entry = n.lastTrick.find((e) => !resting.has(cardKey(e.card)))
    if (entry === undefined) {
      return null
    }
    ;({ player, card } = entry)
    completesTrick = true
  } else {
    return null
  }

  const from = playSource(p, viewPlayer, player, card, geom)
  const { dx, dy } = trickOffset(positionOfPlayer(player, viewPlayer))
  return {
    player,
    card,
    ...from,
    toX: TRICK_CENTER.x + dx,
    toY: TRICK_CENTER.y + dy,
    // The cards already on the table before this play (no winner highlight; the trick isn't won yet).
    resting: placeTrickCards(p.currentTrick, viewPlayer, null),
    completesTrick,
  }
}

/**
 * Where the played card was drawn in the previous frame: the view player's fanned hand if the player is
 * the view player, otherwise the opponent row. Reuses {@link buildHand}/{@link buildOpponents} so the
 * source matches the actual draw to the pixel. During a play the emitted `legal_cards` overlay holds
 * only card objects, so `new Set(prev.legalCards.map(cardKey))` reproduces the hand's raised/flat layout
 * for both games. Falls back to the player's badge if the card can't be located (defensive; should
 * not happen, since the card was in that hand a frame ago).
 */
function playSource(
  prev: CardOverlay,
  viewPlayer: number,
  player: number,
  card: Card,
  geom: TableGeometry,
): { fromX: number; fromY: number; fromW: number; fromH: number } {
  const key = cardKey(card)
  if (player === viewPlayer) {
    const hand = buildHand(
      prev,
      { viewPlayer, controlledPlayers: [], revealAll: true },
      new Set(prev.legalCards.map(cardKey)),
    )
    const shc = hand.find((c) => cardKey(c.card) === key)
    if (shc !== undefined) {
      return { fromX: shc.x + shc.w / 2, fromY: shc.y + shc.h / 2, fromW: shc.w, fromH: shc.h }
    }
  } else {
    const sc = buildOpponents(
      prev,
      { viewPlayer, controlledPlayers: [], revealAll: true },
      new Set(prev.legalCards.map(cardKey)),
      geom,
    ).find((c) => cardKey(c.card) === key)
    if (sc !== undefined) {
      return { fromX: sc.x + sc.w / 2, fromY: sc.y + sc.h / 2, fromW: sc.w, fromH: sc.h }
    }
  }
  const anchor = positionAnchor(positionOfPlayer(player, viewPlayer), geom)
  return { fromX: anchor.x, fromY: anchor.y, fromW: SMALL_W, fromH: SMALL_H }
}

/**
 * The position and scale of the flying card at progress `t` in [0,1]. The first `PLAY_HOLD` fraction
 * holds it at the source (highlighted, by the renderer) so the eye registers which card was picked,
 * then it eases to the center, shrinking from its source size down to the small trick-card size.
 */
export const PLAY_HOLD = 0.3
export function playCardAt(move: PlayMove, t: number): { x: number; y: number; scale: number } {
  const m = t < PLAY_HOLD ? 0 : smoothstep((t - PLAY_HOLD) / (1 - PLAY_HOLD))
  const endScale = SMALL_W / move.fromW
  return {
    x: move.fromX + (move.toX - move.fromX) * m,
    y: move.fromY + (move.toY - move.fromY) * m,
    scale: 1 + (endScale - 1) * m,
  }
}
