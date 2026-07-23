/**
 * The Hearts-specific half of the pure scene layer: the parts of the table that are Hearts and not
 * generic trick-taking — the penalty-point scores in each badge, the hearts-broken status pip, and the
 * contextual rule hints (opening 2♣, follow-suit, the hearts-not-broken lead restriction). Everything a
 * Hearts and a Spades table draw identically — the card codec, the felt palette, the seat/trick/hand
 * geometry, the legal-mask hand fan, the hit-test, and the fly-in/sweep animation helpers — lives in the
 * shared `@renderers/cards/scene.ts` and is re-exported below so this module stays the single Hearts entry point.
 * It draws the recorded overlay from `environments/hearts/overlay.py`. `computeScene` is pure in
 * `state` plus `config`, so the same inputs always yield the same scene, including during replay scrubs.
 */
import type { StepState } from '@game-sandbox/schema'

import {
  asNumberList,
  buildHand,
  buildMoveClock,
  buildOpponents,
  buildSeatsBase,
  buildTrick,
  type Card,
  type CardOverlay,
  type CardTableScene,
  cardKey,
  DEFAULT_GEOMETRY,
  HEARTS,
  HEIGHT,
  padScores,
  readCardOverlay,
  resolveView,
  type SceneConfig,
  type SceneSeatBase,
  SPADES,
  type ViewContext,
  WIDTH,
} from '@renderers/cards/scene.js'

// Re-export the whole shared card-table layer so this module is the single Hearts entry point: the
// renderer and the tests import `WIDTH`, `detectSweep`, `handCardAt`, etc. from here as before.
export * from '@renderers/cards/scene.js'

// --- Hearts card constants (mirror environments/hearts/rules.py) ---
/** A full Hearts hand is thirteen tricks. */
export const NUM_TRICKS = 13

/** The Queen of Spades: suit 2 (spades), face rank 12 (queen). */
export function isQueenOfSpades(card: Card): boolean {
  return card.suit === SPADES && card.rank === 12
}

/** Penalty points a card is worth: 13 for Q♠, 1 per heart, else 0 (mirrors rules.card_points). */
export function cardPoints(card: Card): number {
  if (isQueenOfSpades(card)) {
    return 13
  }
  return card.suit === HEARTS ? 1 : 0
}

/** Suit names for the status-line hints, by suit id. */
export const SUIT_NAMES: Record<number, string> = {
  0: 'clubs',
  1: 'diamonds',
  2: 'spades',
  3: 'hearts',
}
/** Singular suit names for the follow-suit hint. */
export const SUIT_SINGULAR: Record<number, string> = {
  0: 'club',
  1: 'diamond',
  2: 'spade',
  3: 'heart',
}

// --- Hearts scene shapes ---

/** One Hearts seat badge: the shared core plus the seat's running penalty score. */
export interface SceneSeat extends SceneSeatBase {
  score: number
}

/** The top status strip: trick number, hearts-broken flag, a state message, and a rule hint. */
export interface SceneStatus {
  trickText: string
  heartsBroken: boolean
  message: string
  messageTone: 'gold' | 'white'
  hint: string
}

/** Everything needed to paint one static frame of the Hearts table. */
export interface HeartsScene extends CardTableScene<SceneSeat> {
  status: SceneStatus
}

/** The normalized Hearts overlay: the shared card core plus the Hearts-only fields. */
interface HeartsOverlay extends CardOverlay {
  heartsBroken: boolean
  displayScores: number[]
}

/** Read the shared card overlay and add the two Hearts-only fields on top. */
function readOverlay(state: StepState): HeartsOverlay {
  const o = (state.overlay ?? {}) as Record<string, unknown>
  return {
    ...readCardOverlay(state),
    heartsBroken: Boolean(o.hearts_broken),
    displayScores: padScores(asNumberList(o.display_scores)),
  }
}

// --- The scene builder ---

/**
 * Turn one recorded state into the static Hearts table scene: the four seat badges with penalty scores,
 * the central trick (the in-progress trick, or the just-completed trick with its winner highlighted),
 * the opponents' rows, the view seat's fanned hand with legal cards lit and illegal ones greyed, the
 * status strip, and the move-clock chip on the controlled human's turn. Pure in `state` plus `config`,
 * so the same inputs always yield the same scene (the scrubber's same-state-same-frame rule).
 */
export function computeScene(state: StepState, config: SceneConfig = {}): HeartsScene {
  const o = readOverlay(state)
  const view = resolveView(config)

  const seats = buildSeats(o, view)
  const { trick, trickWinner } = buildTrick(o, view.viewSeat)
  const opponents = buildOpponents(o, view.viewSeat, view.revealAll, DEFAULT_GEOMETRY)
  // Hearts reads the emitted legal-cards overlay verbatim: every legal card lights by its key.
  const hand = buildHand(o, view, new Set(o.legalCards.map(cardKey)))
  const status = buildStatus(o, view, trickWinner)
  const moveClock = buildMoveClock(o, view, config.humanTimeoutMs)

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
  }
}

/** Build the four seat badges, adding each seat's running penalty score to the shared core. */
function buildSeats(o: HeartsOverlay, view: ViewContext): SceneSeat[] {
  return buildSeatsBase(o, view, DEFAULT_GEOMETRY).map((base) => ({
    ...base,
    score: o.displayScores[base.seat] ?? 0,
  }))
}

/** Build the status strip text. */
function buildStatus(o: HeartsOverlay, view: ViewContext, trickWinner: number | null): SceneStatus {
  const trickText = o.terminal ? 'hand complete' : `trick ${o.tricksPlayed + 1}/${NUM_TRICKS}`
  const { message, messageTone } = statusMessage(o, view, trickWinner)
  const hint = legalHint(o, view)
  // The end-of-hand ranking is no longer drawn into the canvas: it lives in the host-level
  // GameOverCard.vue (web) and scripts/play.py (Python). The strip keeps only the "Game over" message.
  return { trickText, heartsBroken: o.heartsBroken, message, messageTone, hint }
}

/**
 * The primary-row state message and its tone. First-person ("You", "Your
 * turn") is used only for the seat the user actually controls; a spectator or replay (controlledSeat
 * null) never matches, so the same lines render in the third person ("P2 took the trick", "P0's turn").
 */
function statusMessage(
  o: HeartsOverlay,
  view: ViewContext,
  trickWinner: number | null,
): { message: string; messageTone: 'gold' | 'white' } {
  if (o.terminal) {
    return { message: 'Game over', messageTone: 'gold' }
  }
  // A just-completed trick is shown statically in the center: name who took it and the points.
  if (o.currentTrick.length === 0 && o.lastTrick !== null && trickWinner !== null) {
    const points = o.lastTrick.reduce((sum, e) => sum + cardPoints(e.card), 0)
    const who = trickWinner === view.controlledSeat ? 'You' : `P${trickWinner}`
    const suffix = points ? ` (+${points})` : ''
    return { message: `${who} took the trick${suffix}`, messageTone: 'gold' }
  }
  if (o.turn === view.controlledSeat) {
    return { message: 'Your turn', messageTone: 'gold' }
  }
  return { message: `P${o.turn}'s turn`, messageTone: 'white' }
}

/**
 * The contextual hint explaining the controlled seat's legal options. On the
 * controlled seat's turn it explains why the legal set is what it is (opening 2♣, follow-suit,
 * void/discard, or the hearts-not-broken lead restriction); otherwise — an opponent's turn, or any turn
 * in a spectator/replay view with no controlled seat — it gives third-person table context (never a
 * "you must..." instruction) so the row is never empty.
 */
function legalHint(o: HeartsOverlay, view: ViewContext): string {
  if (o.terminal) {
    return ''
  }
  const turn = o.turn
  const led = o.ledSuit
  if (view.controlledSeat === null || turn !== view.controlledSeat) {
    if (led !== null) {
      return `P${turn} to play  -  ${SUIT_NAMES[led]} were led`
    }
    return `Waiting for P${turn} to lead`
  }

  // It is the controlled seat's turn (which is the bottom view seat), so explain its legal options.
  if (o.tricksPlayed === 0 && o.currentTrick.length === 0) {
    return 'Opening lead  -  you must play the 2 of clubs'
  }

  const hand = o.hands[view.viewSeat] ?? []
  if (led !== null) {
    const canFollow = hand.some((card) => card.suit === led)
    if (canFollow) {
      let hint = `Follow suit  -  you must play a ${SUIT_SINGULAR[led]}`
      if (o.tricksPlayed === 0) {
        hint += '; no hearts or Queen of Spades on the first trick'
      }
      return hint
    }
    if (o.tricksPlayed === 0) {
      return `No ${SUIT_NAMES[led]}  -  discard anything except hearts or the Queen of Spades`
    }
    return `No ${SUIT_NAMES[led]}  -  free to discard anything`
  }

  // Leading, past the opening play.
  const nonHearts = hand.filter((card) => card.suit !== HEARTS)
  if (!o.heartsBroken && nonHearts.length > 0) {
    return "Your lead  -  hearts aren't broken yet, so you can't lead a heart"
  }
  if (nonHearts.length === 0) {
    return 'Your lead  -  only hearts left, so you may lead them'
  }
  return 'Your lead  -  hearts are broken, lead any suit'
}
