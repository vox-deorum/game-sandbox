/**
 * The Spades-specific half of the pure scene layer: the parts of the table that are Spades and not
 * generic trick-taking — the per-seat `bid / won` line with its NIL marker and partnership tint, the
 * two team scores, the spades-broken status pip, the phase indicator, and — during the opening round —
 * the clickable grid of bid chips (`0..13`, `0` labelled NIL) laid out in the centre well. Everything a
 * Hearts and a Spades table draw identically — the card codec, the felt palette, the seat/trick/hand
 * geometry, the legal-mask hand fan, the hit-test, and the fly-in/sweep animation helpers — lives in the
 * shared `../cards/scene.ts` (the browser twin of `environments/src/local_play/render_cards.py`) and is
 * re-exported below so this module stays the single Spades entry point.
 *
 * This is the browser twin of the Python pygame renderer in `environments/src/spades/render.py`. The two
 * draw the same recorded overlay (from `environments/src/spades/overlay.py`); when you change the Spades
 * layout here, change `render.py` to match (and vice versa), and the shared table lives in the shared
 * module on both sides. `computeScene` is pure in `state` plus `config`, so the same inputs always yield
 * the same scene (the scrubber's same-state-same-frame rule).
 */
import type { StepState } from '@game-sandbox/schema'

import {
  asNumberList,
  buildHand,
  buildMoveClock,
  buildOpponents,
  buildSeatsBase,
  buildTrick,
  type CardOverlay,
  type CardTableScene,
  cardKey,
  HEIGHT,
  NUM_PLAYERS,
  padScores,
  readCardOverlay,
  resolveView,
  type SceneConfig,
  type SceneSeatBase,
  type TableGeometry,
  type ViewContext,
  WIDTH,
} from '../cards/scene.js'

// Re-export the whole shared card-table layer so this module is the single Spades entry point: the
// renderer and the tests import `WIDTH`, `detectSweep`, `handCardAt`, etc. from here as before.
export * from '../cards/scene.js'

// --- Spades action / partnership constants (mirror environments/src/spades/rules.py) ---
/** The 52 card actions (0..51); a bid is encoded above this offset. */
export const NUM_CARDS = 52
/** Fourteen distinct bids, 0..13 (0 is nil). */
export const NUM_BIDS = 14
/** The bid meaning "I will take zero tricks", worth ±100, scored separately. */
export const NIL_BID = 0
/** The combined action space is `52 + 14`: cards 0..51, then bids as `52 + k`. */
export const BID_OFFSET = NUM_CARDS
/** A full Spades hand is thirteen tricks. */
export const NUM_TRICKS = 13

/** Encode a bid of `bid` tricks (0..13) as its action-space integer `52 + bid` (rules.bid_to_action). */
export function bidToAction(bid: number): number {
  return BID_OFFSET + bid
}
/** The partnership id (0 for seats 0 & 2, 1 for seats 1 & 3) of a seat (rules.team_of). */
export function teamOf(seat: number): number {
  return seat % 2
}
/** The two seats making up a team: (0, 2) for team 0, (1, 3) for team 1 (rules.team_seats). */
export function teamSeats(team: number): [number, number] {
  return [team, team + 2]
}

// --- Spades palette (mirror render.py; the shared card/table colours live in cards/scene.ts) ---
/** The ink for a nil bid, so a NIL chip and a nil badge read apart from an ordinary bid. */
export const NIL_INK = '#f0b060'
/** The two partnership accent colours, so the team scores and badges read as two teams. */
export const TEAM_TINT: Record<number, string> = { 0: '#6cc4ec', 1: '#ec9c78' }
/** A bid chip's felt-green body, its hover body, and its edge (render.py CHIP_BG/CHIP_BG_HOVER/CHIP_EDGE). */
export const CHIP_BG = '#12422d'
export const CHIP_BG_HOVER = '#1e6042'
export const CHIP_EDGE = '#78c896'
/** The bid chips wrap into this many columns (the 14 bids fill a 7×2 grid); render.py BID_CHIP_COLS. */
export const BID_CHIP_COLS = 7

/**
 * Spades' table geometry: the pygame `SpadesRenderer` class-attribute overrides applied to the frontend
 * hearts baseline. The badges are a touch taller than Hearts', so the seats and the north opponent row
 * sit a little lower to clear the taller status strip, and the side badges slide further in so the edge
 * card stacks no longer overlay them.
 */
export const SPADES_GEOMETRY: TableGeometry = {
  northBadgeY: 117,
  opponentRowNorthY: 166,
  badgeW: 168,
  badgeH: 62,
  sideBadgeInset: 176,
}

// --- Spades scene shapes ---

/** One Spades seat badge: the shared core plus this seat's bid, tricks won, nil flag, and partnership. */
export interface SpadesSceneSeat extends SceneSeatBase {
  /** This seat's bid (0..13, 0 is nil), or -1 while it has not yet bid. */
  bid: number
  /** Tricks this seat has taken so far. */
  won: number
  /** True when this seat bid nil (bid 0). */
  isNil: boolean
  /** The seat's partnership id (0 or 1). */
  team: number
}

/** One team's score readout on the status strip's second row. */
export interface SceneTeamScore {
  /** e.g. `P0+P2 (you)`; "(you)" only on the partnership the controlled seat belongs to. */
  label: string
  score: number
  team: number
}

/** The top status strip: phase/trick text, spades-broken flag, a state message, and the team scores. */
export interface SpadesSceneStatus {
  phaseText: string
  spadesBroken: boolean
  message: string
  messageTone: 'gold' | 'white'
  teamScores: SceneTeamScore[]
}

/** One clickable bid chip in the centre grid (twin of render.py's `_bid_rects` entries). */
export interface SceneBidChip {
  /** The bid value 0..13 (0 is nil). */
  bid: number
  /** The action-space integer `52 + bid` this chip sends. */
  action: number
  x: number
  y: number
  w: number
  h: number
  /** In the emitted legal-action mask for the current turn (drawn lit; else greyed). */
  enabled: boolean
  /** Clickable: enabled, and the user controls the seat currently on turn. */
  controllable: boolean
}

/** The bidding-round centre panel: the prompt line above a grid of 14 bid chips. */
export interface SceneBidPanel {
  chips: SceneBidChip[]
  /** e.g. "Choose your bid" on the controlled seat's turn, else "P2 is bidding". */
  prompt: string
  promptTone: 'gold' | 'white'
  /** The prompt's centre point (the chips carry their own absolute rects). */
  x: number
  y: number
}

/** Everything needed to paint one static frame of the Spades table. */
export interface SpadesScene extends CardTableScene<SpadesSceneSeat> {
  status: SpadesSceneStatus
  phase: 'bidding' | 'play'
  spadesBroken: boolean
  /** The centre bid grid during the opening round, or null once play begins. */
  bidPanel: SceneBidPanel | null
}

/** The normalized Spades overlay: the shared card core plus the Spades-only fields. */
interface SpadesOverlay extends CardOverlay {
  phase: 'bidding' | 'play'
  bids: number[]
  tricksWon: number[]
  teamScores: number[]
  spadesBroken: boolean
  displayScores: number[]
  /** Legal bids (0..13) during the bidding phase; empty during play or at terminal. */
  legalBids: number[]
}

/** Pad a per-seat bids array out to all four seats, defaulting a missing entry to -1 (not yet bid). */
function padBids(bids: number[]): number[] {
  return Array.from({ length: NUM_PLAYERS }, (_, i) => bids[i] ?? -1)
}

/** Read the shared card overlay and add the Spades-only fields on top. */
function readOverlay(state: StepState): SpadesOverlay {
  const o = (state.overlay ?? {}) as Record<string, unknown>
  const teamScores = asNumberList(o.team_scores)
  return {
    ...readCardOverlay(state),
    phase: o.phase === 'bidding' ? 'bidding' : 'play',
    bids: padBids(asNumberList(o.bids)),
    tricksWon: padScores(asNumberList(o.tricks_won)),
    teamScores: [teamScores[0] ?? 0, teamScores[1] ?? 0],
    spadesBroken: Boolean(o.spades_broken),
    displayScores: padScores(asNumberList(o.display_scores)),
    legalBids: asNumberList(o.legal_bids),
  }
}

// --- The scene builder ---

/**
 * Turn one recorded state into the static Spades table scene: the four seat badges with their bid/won
 * lines and partnership tabs, the central trick (or the bid grid during the opening round), the
 * opponents' rows, the view seat's fanned hand with legal cards lit and illegal ones greyed, the status
 * strip with both team scores, and the move-clock chip on the controlled human's turn. Pure in `state`
 * plus `config`, so the same inputs always yield the same scene (the scrubber's same-state-same-frame
 * rule).
 */
export function computeScene(state: StepState, config: SceneConfig = {}): SpadesScene {
  const o = readOverlay(state)
  const view = resolveView(config)

  const seats = buildSeats(o, view)
  const { trick, trickWinner } = buildTrick(o, view.viewSeat)
  const opponents = buildOpponents(o, view.viewSeat, view.revealAll, SPADES_GEOMETRY)
  // Spades reads the emitted legal-cards overlay verbatim: during bidding it is empty (you cannot play
  // a card until you have bid), so every hand card greys — the correct read
  // (render.py `_legal_cards_from_overlay`).
  const hand = buildHand(o, view, new Set(o.legalCards.map(cardKey)))
  const status = buildStatus(o, view, trickWinner)
  const moveClock = buildMoveClock(o, view, config.humanTimeoutMs)
  const bidPanel = buildBidPanel(o, view)

  return {
    width: WIDTH,
    height: HEIGHT,
    viewSeat: view.viewSeat,
    revealAll: view.revealAll,
    terminal: o.terminal,
    seats,
    trick,
    opponents,
    hand,
    status,
    moveClock,
    phase: o.phase,
    spadesBroken: o.spadesBroken,
    bidPanel,
  }
}

/** Build the four seat badges, adding each seat's bid, tricks won, nil flag, and team to the core. */
function buildSeats(o: SpadesOverlay, view: ViewContext): SpadesSceneSeat[] {
  return buildSeatsBase(o, view, SPADES_GEOMETRY).map((base) => {
    const bid = o.bids[base.seat] ?? -1
    return {
      ...base,
      bid,
      won: o.tricksWon[base.seat] ?? 0,
      isNil: bid === NIL_BID,
      team: teamOf(base.seat),
    }
  })
}

/** Whether the seat the user controls is the one currently choosing (first-person, clickable). */
function isViewTurn(o: SpadesOverlay, view: ViewContext): boolean {
  return view.controlledSeat !== null && !o.terminal && o.turn === view.controlledSeat
}

/** Build the status strip: phase text, spades-broken flag, the state message, and both team scores. */
function buildStatus(
  o: SpadesOverlay,
  view: ViewContext,
  trickWinner: number | null,
): SpadesSceneStatus {
  const phaseText = o.terminal
    ? 'hand complete'
    : o.phase === 'bidding'
      ? 'bidding'
      : `trick ${o.tricksPlayed + 1}/${NUM_TRICKS}`
  const { message, messageTone } = statusMessage(o, view, trickWinner)
  const teamScores: SceneTeamScore[] = [0, 1].map((team) => {
    const [a, b] = teamSeats(team)
    const mine = view.controlledSeat === a || view.controlledSeat === b
    return { label: `P${a}+P${b}${mine ? ' (you)' : ''}`, score: o.teamScores[team] ?? 0, team }
  })
  return { phaseText, spadesBroken: o.spadesBroken, message, messageTone, teamScores }
}

/**
 * The primary-row state message and its tone (render.py `_status_message`). First-person ("You", "Your
 * bid", "Your turn") is used only for the seat the user actually controls; a spectator or replay
 * (controlledSeat null) never matches, so the same lines render in the third person ("P2 took the
 * trick", "P0 to bid").
 */
function statusMessage(
  o: SpadesOverlay,
  view: ViewContext,
  trickWinner: number | null,
): { message: string; messageTone: 'gold' | 'white' } {
  if (o.terminal) {
    return { message: 'Game over', messageTone: 'gold' }
  }
  // A just-completed trick is shown statically in the centre: name who took it. The lastTrick guard
  // keeps this off during the opening bid round (lastTrick is null until a trick lands).
  if (o.currentTrick.length === 0 && o.lastTrick !== null && trickWinner !== null) {
    const who = trickWinner === view.controlledSeat ? 'You' : `P${trickWinner}`
    return { message: `${who} took the trick`, messageTone: 'gold' }
  }
  const bidding = o.phase === 'bidding'
  if (o.turn === view.controlledSeat) {
    return { message: bidding ? 'Your bid' : 'Your turn', messageTone: 'gold' }
  }
  return { message: `P${o.turn} ${bidding ? 'to bid' : 'to play'}`, messageTone: 'white' }
}

/**
 * Build the bidding-round centre panel: a `7 × 2` grid of the 14 bid chips centred on the table well,
 * with the prompt above it (mirror render.py `_draw_bid_chips`, chip 50×52, gap 4, vgap 8, prompt 26px
 * above the grid). Returns null once play begins. Every chip carries its absolute rect (for the
 * hit-test), whether it is `enabled` (in the emitted `legal_bids` overlay — verbatim, so a partial list
 * greys the rest), and whether it is `controllable` (enabled and the controlled seat is on turn). The
 * chips draw for everyone so the table reads; only the controlled seat's own turn accepts a click.
 */
function buildBidPanel(o: SpadesOverlay, view: ViewContext): SceneBidPanel | null {
  if (o.phase !== 'bidding' || o.terminal) {
    return null
  }
  const chipW = 50
  const chipH = 52
  const gap = 4
  const vgap = 8
  const cols = BID_CHIP_COLS
  const count = NUM_BIDS
  const rows = Math.ceil(count / cols)
  const run = cols * chipW + (cols - 1) * gap
  const startX = Math.floor((WIDTH - run) / 2)
  const blockH = rows * chipH + (rows - 1) * vgap
  const startY = Math.floor(HEIGHT / 2 - blockH / 2)

  const viewTurn = isViewTurn(o, view)
  const legalBids = new Set(o.legalBids)
  const chips: SceneBidChip[] = []
  for (let bid = 0; bid < count; bid++) {
    const col = bid % cols
    const row = Math.floor(bid / cols)
    const action = bidToAction(bid)
    const enabled = legalBids.has(bid)
    chips.push({
      bid,
      action,
      x: startX + col * (chipW + gap),
      y: startY + row * (chipH + vgap),
      w: chipW,
      h: chipH,
      enabled,
      controllable: enabled && viewTurn,
    })
  }

  const prompt = viewTurn ? 'Choose your bid' : `P${o.turn} is bidding`
  return { chips, prompt, promptTone: viewTurn ? 'gold' : 'white', x: WIDTH / 2, y: startY - 26 }
}

// --- Hit-testing (twin of render.py bid_action_at_pos) ---

/**
 * The bid chip under a point in internal (960×720) coordinates, or null if none. The chips do not
 * overlap, so a simple forward scan suffices. Legality is ignored here; the caller decides whether to
 * accept the click (only a controllable chip is wired).
 */
export function bidChipAt(panel: SceneBidPanel, x: number, y: number): SceneBidChip | null {
  for (const chip of panel.chips) {
    if (x >= chip.x && x <= chip.x + chip.w && y >= chip.y && y <= chip.y + chip.h) {
      return chip
    }
  }
  return null
}
