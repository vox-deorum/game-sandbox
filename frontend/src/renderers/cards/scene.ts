/**
 * The pure, game-agnostic half of a trick-taking card renderer: the parts every four-seat card game
 * (Hearts, Spades) lays out identically — the card codec, the felt palette, the seat/trick/hand/opponent
 * geometry, the legal-mask-driven hand fan, the hit-test, and the pure animation helpers (the card-play
 * fly-in and the trick-won sweep). A game module composes these builders and adds only its own overlay
 * fields, seat content, and status strip. No canvas and no accumulated history, so it is unit-testable in
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
import type { StepState } from '@game-sandbox/schema'

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

/** Thin object accessors, kept for callers that prefer function form; every caller passes a Card. */
export function suitOf(card: Card): number {
  return card.suit
}
export function rankOf(card: Card): number {
  return card.rank
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
/** Card-face dimensions for the view seat's fanned hand. */
export const CARD_W = 64
export const CARD_H = 92
/** Smaller card-face dimensions for trick cards and revealed opponent hands. */
export const SMALL_W = 48
export const SMALL_H = 70

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

/** The center of the table, where the trick is laid out. */
export const TRICK_CENTER = { x: WIDTH / 2, y: HEIGHT / 2 }

// --- Per-game table geometry ---

/**
 * The handful of table measurements a game varies. They are threaded through the geometry helpers so
 * Hearts uses the defaults and Spades passes its own without duplicating layout code.
 */
export interface TableGeometry {
  /** The y of the North seat badge center. */
  northBadgeY: number
  /** The y of the North opponent card row. */
  opponentRowNorthY: number
  /** Seat badge width. */
  badgeW: number
  /** Seat badge height. */
  badgeH: number
  /** How far the West and East badges sit in from the side edges. */
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

/** The game-agnostic core of a seat badge; a game extends it with its own fields (score, bid/won). */
export interface SceneSeatBase {
  seat: number
  /** Screen slot 0=South (view), 1=West, 2=North, 3=East. */
  slot: number
  x: number
  y: number
  label: string
  /** Whose turn it is now (gold highlight); false at terminal. */
  isTurn: boolean
  /** The bottom (view) seat, which the user controls in live play. */
  isYou: boolean
}

/** A face-up card in the central trick, positioned at its player's screen slot offset. */
export interface SceneTrickCard {
  seat: number
  card: Card
  x: number
  y: number
  /** Highlighted gold when this scene shows a completed trick and this card won it. */
  isWinner: boolean
}

/** A small card in an opponent's row: face-down in live play, face-up when revealing (spectate/replay). */
export interface SceneCard {
  card: Card
  x: number
  y: number
  w: number
  h: number
  faceUp: boolean
}

/** One card in the view seat's fanned hand. */
export interface SceneHandCard {
  card: Card
  x: number
  y: number
  w: number
  h: number
  /** In the emitted legal-cards set for the current turn: drawn lit and raised; else greyed. */
  legal: boolean
  /** Clickable: legal, it is the view seat's turn, and the user controls the view seat. */
  controllable: boolean
}

/** The active move-clock chip: shown only on the controlled human's turn (hidden in replay/spectate). */
export interface SceneMoveClock {
  x: number
  y: number
  /** The per-move budget in whole seconds, from the session's `human_timeout_ms`. */
  seconds: number
}

/** The game-agnostic core of one static frame; a game's scene extends it with its own status fields. */
export interface CardTableScene<TSeat extends SceneSeatBase = SceneSeatBase> {
  width: number
  height: number
  viewSeat: number
  revealAll: boolean
  terminal: boolean
  seats: TSeat[]
  trick: SceneTrickCard[]
  opponents: SceneCard[]
  hand: SceneHandCard[]
  moveClock: SceneMoveClock | null
}

/** Mount-time facts the scene needs beyond the state, kept out so a `computeScene` stays pure. */
export interface SceneConfig {
  /** The slots this user controls; empty when spectating or replaying (then we reveal all hands). */
  controlledSlots?: readonly string[]
  /** The session's human move-clock budget in ms (meta.human_timeout_ms or its override). */
  humanTimeoutMs?: number | null
}

/** One play in a trick: who played (seat) and what (a card object), in play order. */
export interface TrickEntry {
  seat: number
  card: Card
}

/** The normalized, fully-defaulted core of the overlay every card game reads (snake_case from Python). */
export interface CardOverlay {
  hands: Card[][]
  currentTrick: TrickEntry[]
  lastTrick: TrickEntry[] | null
  lastTrickWinner: number | null
  turn: number
  turnSlot: string
  trickLeader: number
  ledSuit: number | null
  tricksPlayed: number
  legalCards: Card[]
  terminal: boolean
}

// --- Geometry helpers (pure, exported so the sweep math and the renderer share one source) ---

/** Map an absolute seat to a screen slot (0=S,1=W,2=N,3=E) with the view seat at South. */
export function slotOfSeat(seat: number, viewSeat: number): number {
  return (((seat - viewSeat) % NUM_PLAYERS) + NUM_PLAYERS) % NUM_PLAYERS
}

/** The (x, y) center of the seat badge for a screen slot. */
export function seatAnchor(
  slot: number,
  geom: TableGeometry = DEFAULT_GEOMETRY,
): {
  x: number
  y: number
} {
  switch (slot) {
    case 0:
      return { x: WIDTH / 2, y: HEIGHT - 150 } // South (view seat)
    case 1:
      return { x: geom.sideBadgeInset, y: HEIGHT / 2 } // West
    case 2:
      return { x: WIDTH / 2, y: geom.northBadgeY } // North (below the status strip)
    default:
      return { x: WIDTH - geom.sideBadgeInset, y: HEIGHT / 2 } // East
  }
}

/** The center offset (dx, dy) for a card played from a screen slot. */
export function trickOffset(slot: number): { dx: number; dy: number } {
  switch (slot) {
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

/** The seat index for a slot id like "player_2" (mirrors env.possible_agents ordering). */
export function seatOfSlot(slot: string): number {
  const match = /(\d+)$/.exec(slot)
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

/** Validate and normalize a raw array of `{"seat","card"}` entries into `TrickEntry[]` (play order). */
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
    if (typeof v.seat === 'number' && card !== null) {
      entries.push({ seat: v.seat, card })
    }
  }
  return entries
}

export function asNumberList(value: unknown): number[] {
  return Array.isArray(value) ? value.map((v) => Number(v)) : []
}

/** Pad a per-seat number array out to all four seats, defaulting missing entries to 0. */
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
  const hands: Card[][] = Array.from({ length: NUM_PLAYERS }, (_, seat) => asCards(rawHands[seat]))
  const ledSuit = o.led_suit
  return {
    hands,
    currentTrick: asCardEntries(o.current_trick),
    lastTrick: o.last_trick == null ? null : asCardEntries(o.last_trick),
    lastTrickWinner: o.last_trick_winner == null ? null : Number(o.last_trick_winner),
    turn: Number(o.turn ?? 0),
    turnSlot: typeof o.turn_slot === 'string' ? o.turn_slot : `player_${Number(o.turn ?? 0)}`,
    trickLeader: Number(o.trick_leader ?? 0),
    ledSuit: ledSuit == null ? null : Number(ledSuit),
    tricksPlayed: Number(o.tricks_played ?? 0),
    legalCards: asCards(o.legal_cards),
    terminal: Boolean(o.terminal),
  }
}

// --- View resolution (which seat sits at the bottom, and whether opponents are revealed) ---

/**
 * The resolved viewing context for one scene: which seat sits at the bottom, which seat (if any) the
 * user actually controls, and whether to reveal every hand. The crucial split is `viewSeat` vs
 * `controlledSeat`: layout (the bottom seat, the fanned hand) keys off `viewSeat`, but everything that
 * speaks in the first person or accepts input — the "(you)" tag, "Your turn", the rule hint, the move
 * clock, clickability — keys off `controlledSeat`. A spectator or replay has `controlledSeat: null`, so
 * none of that first-person language leaks even though a seat still sits at the bottom.
 */
export interface ViewContext {
  viewSeat: number
  controlledSeat: number | null
  revealAll: boolean
}

/**
 * Resolve the {@link ViewContext} from the mount config.
 *
 * The recorded overlay always carries all four hands. In live human play the user controls one slot,
 * so that seat sits at the bottom, is the controlled seat, and the opponents are face-down (no
 * peeking). With no controlled slots (a spectator watching, or a replay) we reveal every hand, default
 * the view to seat 0, and leave `controlledSeat` null. The "(you)" marker and first-person status follow
 * real control rather
 * than always tagging the bottom seat, since a replay's bottom seat is not the viewer.
 */
export function resolveView(config: SceneConfig): ViewContext {
  const controlled = config.controlledSlots ?? []
  if (controlled.length === 0) {
    return { viewSeat: 0, controlledSeat: null, revealAll: true }
  }
  const seat = seatOfSlot(controlled[0] as string)
  return { viewSeat: seat, controlledSeat: seat, revealAll: false }
}

// --- The shared scene builders (a game composes these in its own computeScene) ---

/**
 * The geometric core of the four seat badges: seat, screen slot, badge center, "(you)"-aware label, and
 * the active-turn flag. A game maps over these to add its own per-seat
 * fields (Hearts' running score, Spades' bid/won and partnership).
 */
export function buildSeatsBase(
  o: CardOverlay,
  view: ViewContext,
  geom: TableGeometry,
): SceneSeatBase[] {
  return Array.from({ length: NUM_PLAYERS }, (_, seat) => {
    const slot = slotOfSeat(seat, view.viewSeat)
    const { x, y } = seatAnchor(slot, geom)
    // "(you)" tags the seat the user actually controls, which is null (so never matched) when
    // spectating or replaying even though that seat still sits at the bottom.
    const isYou = seat === view.controlledSeat
    return {
      seat,
      slot,
      x,
      y,
      label: isYou ? `P${seat} (you)` : `P${seat}`,
      isTurn: !o.terminal && seat === o.turn,
      isYou,
    }
  })
}

/**
 * Place a list of `{seat, card}` trick entries at their screen-slot offsets around the table center,
 * flagging the winner (if any). Shared by {@link buildTrick} and the play fly-in's "resting" cards so
 * the static center cards and the animated ones agree on geometry to the pixel.
 */
function placeTrickCards(
  entries: ReadonlyArray<TrickEntry>,
  viewSeat: number,
  winner: number | null,
): SceneTrickCard[] {
  return entries.map(({ seat, card }) => {
    const { dx, dy } = trickOffset(slotOfSeat(seat, viewSeat))
    return {
      seat,
      card,
      x: TRICK_CENTER.x + dx,
      y: TRICK_CENTER.y + dy,
      isWinner: winner !== null && seat === winner,
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
  viewSeat: number,
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
  return { trick: placeTrickCards(entries, viewSeat, winner), trickWinner: winner }
}

/** Lay out the three non-view seats' cards along their table edges. */
export function buildOpponents(
  o: CardOverlay,
  viewSeat: number,
  revealAll: boolean,
  geom: TableGeometry,
): SceneCard[] {
  const cards: SceneCard[] = []
  for (let seat = 0; seat < NUM_PLAYERS; seat++) {
    if (seat === viewSeat) {
      continue
    }
    const slot = slotOfSeat(seat, viewSeat)
    const hand = o.hands[seat] ?? []
    const count = hand.length
    if (count === 0) {
      continue
    }
    const vertical = slot === 1 || slot === 3 // West / East sit along the side edges.
    const span = (vertical ? HEIGHT : WIDTH) - 360
    const step = count > 1 ? Math.min(SMALL_W - 14, Math.floor(span / count)) : 0
    const run = step * (count - 1) + SMALL_W
    for (let i = 0; i < count; i++) {
      let x: number
      let y: number
      if (vertical) {
        x = slot === 1 ? 36 : WIDTH - 36 - SMALL_W
        y = Math.floor((HEIGHT - run) / 2) + i * step
      } else {
        x = Math.floor((WIDTH - run) / 2) + i * step
        y = geom.opponentRowNorthY // North row sits just under the top seat badge.
      }
      cards.push({ card: hand[i] as Card, x, y, w: SMALL_W, h: SMALL_H, faceUp: revealAll })
    }
  }
  return cards
}

/**
 * Fan the view seat's hand across the bottom, marking each card legal (lit and raised) or illegal
 * (greyed). Legality reads the passed `legalKeys` set of {@link cardKey} identities — which the game
 * derives verbatim from the emitted `legal_cards` overlay, so the browser never recomputes the rules;
 * the set is the current turn's,
 * so a card lights only when it is the view seat's turn. A card is clickable when it is legal, it is the
 * view seat's turn, and the user controls that seat.
 */
export function buildHand(
  o: CardOverlay,
  view: ViewContext,
  legalKeys: ReadonlySet<string>,
): SceneHandCard[] {
  const hand = o.hands[view.viewSeat] ?? []
  const count = hand.length
  if (count === 0) {
    return []
  }
  // Clickable only when the user controls the seat shown at the bottom and it is that seat's turn;
  // `controlledSeat` is null (so never equals `o.turn`) when spectating or replaying, leaving the
  // whole hand inert and draw-only.
  const controllableTurn =
    view.controlledSeat !== null && !o.terminal && o.turn === view.controlledSeat

  const margin = 40
  const avail = WIDTH - 2 * margin
  // Overlap as needed so all cards fit within the available width.
  const step = count > 1 ? Math.min(CARD_W + 6, Math.floor((avail - CARD_W) / (count - 1))) : 0
  const run = step * (count - 1) + CARD_W
  const startX = Math.floor((WIDTH - run) / 2)
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

/**
 * The move-clock chip, shown only when it is the turn of a slot this user controls and the hand is not
 * over. That condition is empty in a replay or a spectator view (no controlled slots), so the clock is
 * naturally hidden there, satisfying "show the move clock live, hide it in replay". The value is the
 * session's per-move budget; a true ticking countdown is host chrome, not the deterministic renderer.
 */
export function buildMoveClock(
  o: CardOverlay,
  view: ViewContext,
  humanTimeoutMs: number | null | undefined,
): SceneMoveClock | null {
  if (o.terminal || humanTimeoutMs == null || humanTimeoutMs <= 0) {
    return null
  }
  // Only on the controlled seat's own turn; null `controlledSeat` (spectator/replay) never matches.
  if (view.controlledSeat === null || o.turn !== view.controlledSeat) {
    return null
  }
  // Sit the chip just above the South (view) seat badge, where the active player looks.
  const south = seatAnchor(0)
  return { x: south.x, y: south.y - 56, seconds: Math.round(humanTimeoutMs / 1000) }
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

/** One card sliding into the winner's seat during the sweep. */
export interface SweepCard {
  seat: number
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
 * four cards at their center positions, sliding to the winner's seat) or null when nothing was swept.
 * Pure, so the renderer can decide to animate without holding any hidden state of its own. A game may
 * layer its own flourish (a points/contract pill) on top from the returned `cards` and `winner`.
 */
export function detectSweep(
  prev: StepState | null,
  next: StepState,
  viewSeat: number,
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
  const winnerAnchor = seatAnchor(slotOfSeat(n.lastTrickWinner, viewSeat), geom)
  const cards: SweepCard[] = n.lastTrick.map(({ seat, card }) => {
    const { dx, dy } = trickOffset(slotOfSeat(seat, viewSeat))
    return { seat, card, fromX: TRICK_CENTER.x + dx, fromY: TRICK_CENTER.y + dy }
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
 * the cards in place (the winner's card pulses), then they slide and shrink into the winner's seat
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
  seat: number
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
  viewSeat: number,
  geom: TableGeometry = DEFAULT_GEOMETRY,
): PlayMove | null {
  if (prev === null) {
    return null
  }
  const p = readCardOverlay(prev)
  const n = readCardOverlay(next)

  let seat: number
  let card: Card
  let completesTrick: boolean
  if (n.tricksPlayed === p.tricksPlayed && n.currentTrick.length === p.currentTrick.length + 1) {
    // Cards 1–3: one new entry appended to the same in-progress trick.
    const entry = n.currentTrick[n.currentTrick.length - 1]
    if (entry === undefined) {
      return null
    }
    ;({ seat, card } = entry)
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
    ;({ seat, card } = entry)
    completesTrick = true
  } else {
    return null
  }

  const from = playSource(p, viewSeat, seat, card, geom)
  const { dx, dy } = trickOffset(slotOfSeat(seat, viewSeat))
  return {
    seat,
    card,
    ...from,
    toX: TRICK_CENTER.x + dx,
    toY: TRICK_CENTER.y + dy,
    // The cards already on the table before this play (no winner highlight; the trick isn't won yet).
    resting: placeTrickCards(p.currentTrick, viewSeat, null),
    completesTrick,
  }
}

/**
 * Where the played card was drawn in the previous frame: the view seat's fanned hand if the player is
 * the view seat, otherwise the opponent row. Reuses {@link buildHand}/{@link buildOpponents} so the
 * source matches the actual draw to the pixel. During a play the emitted `legal_cards` overlay holds
 * only card objects, so `new Set(prev.legalCards.map(cardKey))` reproduces the hand's raised/flat layout
 * for both games. Falls back to the player's seat badge if the card can't be located (defensive; should
 * not happen, since the card was in that hand a frame ago).
 */
function playSource(
  prev: CardOverlay,
  viewSeat: number,
  seat: number,
  card: Card,
  geom: TableGeometry,
): { fromX: number; fromY: number; fromW: number; fromH: number } {
  const key = cardKey(card)
  if (seat === viewSeat) {
    const hand = buildHand(
      prev,
      { viewSeat, controlledSeat: null, revealAll: true },
      new Set(prev.legalCards.map(cardKey)),
    )
    const shc = hand.find((c) => cardKey(c.card) === key)
    if (shc !== undefined) {
      return { fromX: shc.x + shc.w / 2, fromY: shc.y + shc.h / 2, fromW: shc.w, fromH: shc.h }
    }
  } else {
    const sc = buildOpponents(prev, viewSeat, true, geom).find((c) => cardKey(c.card) === key)
    if (sc !== undefined) {
      return { fromX: sc.x + sc.w / 2, fromY: sc.y + sc.h / 2, fromW: sc.w, fromH: sc.h }
    }
  }
  const anchor = seatAnchor(slotOfSeat(seat, viewSeat), geom)
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
