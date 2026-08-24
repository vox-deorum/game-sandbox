import type { StepState } from '@game-sandbox/schema'
import { getRenderer } from '@renderers/registry.js'
import { describe, expect, it } from 'vitest'
import {
  type Card,
  cardKey,
  computeScene,
  detectPlay,
  detectSweep,
  HEIGHT,
  type HeartsScene,
  handCardAt,
  PLAY_HOLD,
  playCardAt,
  positionAnchor,
  positionOfPlayer,
  type SceneConfig,
  SWEEP_HOLD,
  sweepCardAt,
  trickOffset,
  WIDTH,
} from './scene.js'
// Importing the barrel registers every renderer, including Hearts, so the registration test below can
// look it up by its metadata key the way the host pages do.
import '@renderers/index.js'
// A checked-in slice of a real four-agent Hearts recording (header + per-step states), produced by
// scripts/gen_hearts_fixture.py through the real harness recording path. Like the Flappy Bird renderer
// test, the determinism fixture doubles as the renderer fixture, so any visual regression has a
// byte-identical, real-shape input. `?raw` (Vite) gives the file as a string under jsdom.
import fixture from '../../../frontend/test/fixtures/hearts-recording.jsonl?raw'

const states: StepState[] = fixture
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .slice(1) // drop the header line
  .map((line) => JSON.parse(line) as StepState)

// Card objects {suit, rank} (rank is the FACE value 2..14). A few named for readable fixtures.
const TWO_CLUBS: Card = { suit: 0, rank: 2 }
const SEVEN_CLUBS: Card = { suit: 0, rank: 7 }
const THREE_CLUBS: Card = { suit: 0, rank: 3 }
const FOUR_CLUBS: Card = { suit: 0, rank: 4 }
const TWO_DIAMONDS: Card = { suit: 1, rank: 2 }
const TWO_SPADES: Card = { suit: 2, rank: 2 }
const TWO_HEARTS: Card = { suit: 3, rank: 2 }
const THREE_HEARTS: Card = { suit: 3, rank: 3 }

const WIDE_SEATS: NonNullable<SceneConfig['seats']> = {
  seat_0: ['player_0', 'player_2'],
  seat_1: ['player_1'],
  seat_2: ['player_3'],
}

/** Build a minimal StepState carrying a Hearts overlay, with the required envelope fields. */
function mkState(overlay: Record<string, unknown>, tick = 0): StepState {
  return {
    schema_version: 1,
    tick,
    agents: {},
    timing: { started_at: tick, duration_ms: 1 },
    overlay,
  }
}

/** One `{player, card}` trick entry, the shape `current_trick`/`last_trick` carry (play order). */
function entry(player: number, card: Card): { player: number; card: Card } {
  return { player, card }
}

/** A baseline overlay; spread overrides over it for each scenario. */
function overlay(over: Record<string, unknown>): Record<string, unknown> {
  return {
    hands: [[], [], [], []],
    current_trick: [],
    last_trick: null,
    last_trick_winner: null,
    turn: 0,
    turn_player: 'player_0',
    trick_leader: 0,
    led_suit: null,
    hearts_broken: false,
    tricks_played: 0,
    display_scores: [0, 0, 0, 0],
    leaderboard_scores: [0, 0, 0, 0],
    legal_cards: [],
    terminal: false,
    ...over,
  }
}

const litCards = (scene: HeartsScene): Card[] =>
  scene.hand.filter((c) => c.legal).map((c) => c.card)
const greyCards = (scene: HeartsScene): Card[] =>
  scene.hand.filter((c) => !c.legal).map((c) => c.card)

describe('computeScene greying from the legal-action mask', () => {
  // The renderer must never reimplement the rules: a hand card is lit exactly when its id is in the
  // emitted legal-action mask, and greyed otherwise. These three states are the representative shapes
  // the plan calls out (first trick, follow-suit, hearts-not-broken lead).

  it('first trick: only the 2 of clubs is legal, the rest are greyed', () => {
    const state = mkState(
      overlay({
        hands: [[TWO_CLUBS, SEVEN_CLUBS, TWO_DIAMONDS, TWO_SPADES, TWO_HEARTS], [], [], []],
        turn: 0,
        tricks_played: 0,
        legal_cards: [TWO_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(litCards(scene)).toEqual([TWO_CLUBS])
    expect(greyCards(scene)).toEqual([SEVEN_CLUBS, TWO_DIAMONDS, TWO_SPADES, TWO_HEARTS])
    expect(scene.status.hint).toBe('Opening lead  -  you must play the 2 of clubs')
  })

  it('follow suit: clubs were led, only the held clubs are legal', () => {
    const state = mkState(
      overlay({
        hands: [[THREE_CLUBS, FOUR_CLUBS, TWO_HEARTS, THREE_HEARTS], [], [], []],
        current_trick: [entry(2, SEVEN_CLUBS)],
        led_suit: 0,
        turn: 0,
        tricks_played: 3,
        legal_cards: [THREE_CLUBS, FOUR_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(litCards(scene)).toEqual([THREE_CLUBS, FOUR_CLUBS])
    expect(greyCards(scene)).toEqual([TWO_HEARTS, THREE_HEARTS])
    expect(scene.status.hint).toBe('Follow suit  -  you must play a club')
  })

  it('hearts not broken on the lead: hearts are greyed', () => {
    const state = mkState(
      overlay({
        hands: [[SEVEN_CLUBS, TWO_HEARTS, THREE_HEARTS], [], [], []],
        led_suit: null,
        turn: 0,
        tricks_played: 2,
        hearts_broken: false,
        legal_cards: [SEVEN_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(litCards(scene)).toEqual([SEVEN_CLUBS])
    expect(greyCards(scene)).toEqual([TWO_HEARTS, THREE_HEARTS])
    expect(scene.status.hint).toBe(
      "Your lead  -  hearts aren't broken yet, so you can't lead a heart",
    )
  })

  it('greys the whole hand when it is not the view player turn (the mask is the other player)', () => {
    // legal_cards belongs to the current turn (player 1), whose cards the view player does not hold, so
    // none of the view player's cards light. When you cannot act, nothing is lit.
    const state = mkState(
      overlay({
        hands: [[THREE_CLUBS, FOUR_CLUBS], [SEVEN_CLUBS], [], []],
        current_trick: [entry(0, TWO_CLUBS)],
        led_suit: 0,
        turn: 1,
        turn_player: 'player_1',
        tricks_played: 1,
        legal_cards: [SEVEN_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(litCards(scene)).toEqual([])
    expect(greyCards(scene)).toEqual([THREE_CLUBS, FOUR_CLUBS])
  })
})

describe('computeScene scores, players, and the turn indicator', () => {
  it('renders the per-player penalty scores and highlights the active player', () => {
    const state = mkState(
      overlay({
        display_scores: [2, 17, 2, 5],
        turn: 2,
        turn_player: 'player_2',
        tricks_played: 5,
      }),
    )
    const scene = computeScene(state) // spectator: no controlled player ids
    expect(scene.players.map((p) => p.score)).toEqual([2, 17, 2, 5])
    expect(scene.players.map((p) => p.isTurn)).toEqual([false, false, true, false])
    // A spectator's players are plain P0..P3 (no "(you)") and the trick counter reads 1-based.
    expect(scene.players.map((p) => p.label)).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(scene.status.trickText).toBe('trick 6/13')
  })

  it('tags the controlled player "(you)" and reads "Your turn" on its turn', () => {
    const state = mkState(overlay({ turn: 0, turn_player: 'player_0' }))
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(scene.players[0]?.label).toBe('P0 (you)')
    expect(scene.players[0]?.isYou).toBe(true)
    expect(scene.status.message).toBe('Your turn')
  })

  it('inherits shared wide-seat labels and grouping for a synthetic Hearts layout', () => {
    const scene = computeScene(mkState(overlay({})), {
      controlledPlayers: ['player_0'],
      seats: WIDE_SEATS,
    })

    expect(scene.players.map((player) => player.label)).toEqual([
      'S0 · P0 (you)',
      'P1',
      'S0 · P2',
      'P3',
    ])
    expect(scene.players.map((player) => player.assignmentSeat)).toEqual([
      'seat_0',
      null,
      'seat_0',
      null,
    ])
    expect(scene.players.map((player) => player.assignmentGroup)).toEqual([0, null, 0, null])
  })

  it('shows the move clock only on the controlled human turn, never in replay', () => {
    const onTurn = overlay({ turn: 0, turn_player: 'player_0' })
    // Live human, your turn: the chip carries the session budget, which the renderer counts down.
    expect(
      computeScene(mkState(onTurn), { controlledPlayers: ['player_0'], humanTimeoutMs: 60_000 })
        .moveClock?.totalMs,
    ).toBe(60_000)
    // Replay / spectator (no controlled player ids): hidden.
    expect(computeScene(mkState(onTurn), { humanTimeoutMs: 60_000 }).moveClock).toBeNull()
    // Live human, but not your turn: hidden.
    const otherTurn = overlay({ turn: 1, turn_player: 'player_1' })
    expect(
      computeScene(mkState(otherTurn), { controlledPlayers: ['player_0'], humanTimeoutMs: 60_000 })
        .moveClock,
    ).toBeNull()
  })

  it('keeps the status and hint third-person for a spectator even when player 0 is active', () => {
    // A spectator / replay has no controlled player ids, so the view defaults to player 0. First-person
    // language ("Your turn", "You took the trick", "you must play...") must never leak to it: only the
    // player the user actually controls speaks in the first person.
    const turn0 = mkState(
      overlay({ turn: 0, turn_player: 'player_0', led_suit: null, tricks_played: 2 }),
    )
    const turnScene = computeScene(turn0)
    expect(turnScene.status.message).toBe("P0's turn")
    expect(turnScene.status.hint).toBe('Waiting for P0 to lead')
    expect(turnScene.players[0]?.isYou).toBe(false)

    // A just-completed trick won by player 0 reads "P0 took the trick", not "You took the trick".
    const won0 = mkState(
      overlay({
        current_trick: [],
        last_trick: [
          entry(0, TWO_CLUBS),
          entry(1, THREE_CLUBS),
          entry(2, FOUR_CLUBS),
          entry(3, SEVEN_CLUBS),
        ],
        last_trick_winner: 0,
        turn: 0,
        tricks_played: 1,
      }),
    )
    expect(computeScene(won0).status.message).toBe('P0 took the trick')
  })
})

describe('on-screen input (hit-testing and clickability)', () => {
  it('marks a legal card on the view player turn controllable, and hit-tests front-most first', () => {
    const state = mkState(
      overlay({
        hands: [[THREE_CLUBS, FOUR_CLUBS, TWO_HEARTS], [], [], []],
        turn: 0,
        led_suit: 0,
        current_trick: [entry(3, TWO_CLUBS)],
        tricks_played: 1,
        legal_cards: [THREE_CLUBS, FOUR_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    const controllable = scene.hand.filter((c) => c.controllable).map((c) => c.card)
    expect(controllable).toEqual([THREE_CLUBS, FOUR_CLUBS]) // legal + my turn + I control the player

    // A point inside the last (front-most) card resolves to it even where cards overlap.
    const last = scene.hand[scene.hand.length - 1]
    if (last === undefined) {
      throw new Error('empty hand')
    }
    const hit = handCardAt(scene.hand, last.x + last.w / 2, last.y + last.h / 2)
    expect(hit?.card).toBe(last.card)
    // A point above the fan hits nothing.
    expect(handCardAt(scene.hand, last.x, -5)).toBeNull()
  })

  it('makes no card controllable in a replay (no controlled player ids)', () => {
    const state = mkState(
      overlay({ hands: [[THREE_CLUBS], [], [], []], turn: 0, legal_cards: [THREE_CLUBS] }),
    )
    const scene = computeScene(state)
    expect(scene.hand.every((c) => !c.controllable)).toBe(true)
    expect(scene.revealAll).toBe(true) // opponents revealed when spectating / replaying
  })
})

describe('the recorded multi-agent Hearts replay', () => {
  it('replays trick by trick: the center grows to four then resets, with a winner on completion', () => {
    let completedTricks = 0
    for (const state of states) {
      const scene = computeScene(state)
      const o = state.overlay as Record<string, unknown>
      const currentLen = (o.current_trick as unknown[]).length
      if (currentLen > 0) {
        // Mid-trick: the center shows exactly the cards played so far, no winner highlight.
        expect(scene.trick).toHaveLength(currentLen)
        expect(scene.trick.every((c) => !c.isWinner)).toBe(true)
      } else if (o.last_trick !== null) {
        // A completed trick (including the last one, shown under the "Game over" text at terminal):
        // all four cards shown with the winner highlighted exactly once.
        expect(scene.trick).toHaveLength(4)
        expect(scene.trick.filter((c) => c.isWinner)).toHaveLength(1)
        expect(scene.trick.find((c) => c.isWinner)?.player).toBe(o.last_trick_winner)
        completedTricks++
      }
    }
    expect(completedTricks).toBe(13) // a full hand is thirteen tricks
  })

  it('renders the final per-player penalty scores from the terminal state', () => {
    const terminal = states.at(-1)
    if (terminal === undefined) {
      throw new Error('fixture has no states')
    }
    const scene = computeScene(terminal)
    expect(scene.terminal).toBe(true)
    expect(scene.players.map((p) => p.score)).toEqual([2, 17, 2, 5]) // sums to 26: a normal hand
    // The end-of-hand ranking moved to the host-level leaderboard (see standings.test.ts); the strip
    // now only carries the "Game over" message at terminal.
    expect(scene.status.message).toBe('Game over')
    expect(scene.hand).toHaveLength(0) // every card has been played
  })

  it('is pure: shuffled states yield the same scenes as in order (the scrubber property)', () => {
    const inOrder = states.map((s) => computeScene(s))
    const shuffled = [...states.keys()].sort(
      (a, b) => ((a * 7 + 3) % states.length) - ((b * 7 + 3) % states.length),
    )
    for (const i of shuffled) {
      expect(computeScene(states[i] as StepState)).toEqual(inOrder[i])
    }
  })
})

describe('the trick-won sweep animation (pure, replay-able)', () => {
  it('detects a just-completed trick and sweeps its cards into the winner', () => {
    // Find the first completion frame in the fixture and the state right before it.
    const completionIdx = states.findIndex((s) => {
      const o = s.overlay as Record<string, unknown>
      return (o.current_trick as unknown[]).length === 0 && o.last_trick !== null
    })
    expect(completionIdx).toBeGreaterThan(0)
    const prev = states[completionIdx - 1] as StepState
    const next = states[completionIdx] as StepState
    const winner = (next.overlay as Record<string, unknown>).last_trick_winner as number

    const sweep = detectSweep(prev, next, 0)
    expect(sweep).not.toBeNull()
    if (sweep === null) {
      throw new Error('no sweep')
    }
    expect(sweep.cards).toHaveLength(4)
    expect(sweep.winner).toBe(winner)
    // The cards' destination is the winner's player anchor for the bottom-player view.
    const anchor = positionAnchor(positionOfPlayer(winner, 0))
    expect(sweep.toX).toBe(anchor.x)
    expect(sweep.toY).toBe(anchor.y)

    // At t=0 a card sits at full size on its played position; by t=1 it has shrunk into the winner.
    const card = sweep.cards[0]
    if (card === undefined) {
      throw new Error('no card')
    }
    const atStart = sweepCardAt(card, sweep, 0)
    expect(atStart.x).toBe(card.fromX)
    expect(atStart.y).toBe(card.fromY)
    expect(atStart.scale).toBe(1)
    // Through the initial hold the card does not move yet. It moves during the following sweep.
    expect(sweepCardAt(card, sweep, SWEEP_HOLD / 2).x).toBe(card.fromX)
    const atEnd = sweepCardAt(card, sweep, 1)
    expect(atEnd.x).toBeCloseTo(sweep.toX)
    expect(atEnd.y).toBeCloseTo(sweep.toY)
    expect(atEnd.scale).toBeCloseTo(0.3)
  })

  it('does not fire a sweep for a still-growing trick or a repeated state', () => {
    // tick 1: a card was added but the trick is not complete (no last_trick yet).
    expect(detectSweep(states[0] as StepState, states[1] as StepState, 0)).toBeNull()
    // The same state twice: trick count did not advance, so nothing is swept.
    const completionIdx = states.findIndex((s) => {
      const o = s.overlay as Record<string, unknown>
      return (o.current_trick as unknown[]).length === 0 && o.last_trick !== null
    })
    const completion = states[completionIdx] as StepState
    expect(detectSweep(completion, completion, 0)).toBeNull()
  })
})

describe('the card-play fly-in (pure, replay-able)', () => {
  it('detects a single play (cards 1–3) and sources it from the prev hand layout', () => {
    // Player 0 (the bottom view player) plays the 3♣ as the second card of an in-progress trick.
    const prev = mkState(
      overlay({
        hands: [[THREE_CLUBS, FOUR_CLUBS], [], [], []],
        current_trick: [entry(3, TWO_CLUBS)],
        led_suit: 0,
        turn: 0,
        tricks_played: 1,
        legal_cards: [THREE_CLUBS, FOUR_CLUBS],
      }),
    )
    const next = mkState(
      overlay({
        hands: [[FOUR_CLUBS], [], [], []],
        current_trick: [entry(3, TWO_CLUBS), entry(0, THREE_CLUBS)],
        led_suit: 0,
        turn: 1,
        turn_player: 'player_1',
        tricks_played: 1,
      }),
    )
    const move = detectPlay(prev, next, 0)
    expect(move).not.toBeNull()
    if (move === null) {
      throw new Error('no play')
    }
    expect(move.player).toBe(0)
    expect(move.card).toEqual(THREE_CLUBS)
    expect(move.completesTrick).toBe(false)
    expect(move.resting).toHaveLength(1) // the one card already in the center (the 2♣)
    expect(move.resting[0]?.card).toEqual(TWO_CLUBS)

    // The load-bearing assertion: the flyer leaves from exactly where the card was drawn last frame.
    const drawn = computeScene(prev).hand.find((c) => cardKey(c.card) === cardKey(THREE_CLUBS))
    expect(drawn).toBeDefined()
    if (drawn === undefined) {
      throw new Error('card not in prev hand')
    }
    expect(move.fromX).toBe(drawn.x + drawn.w / 2)
    expect(move.fromY).toBe(drawn.y + drawn.h / 2)
    expect(move.fromW).toBe(drawn.w)

    // The target is the card's resting trick-offset spot in the center (identical to buildTrick).
    const { dx, dy } = trickOffset(positionOfPlayer(0, 0))
    expect(move.toX).toBe(WIDTH / 2 + dx)
    expect(move.toY).toBe(HEIGHT / 2 + dy)
  })

  it('sources an opponent play from their revealed row', () => {
    // Player 2 (an opponent) leads the 2♣; the flyer comes from player 2's row, sized SMALL.
    const prev = mkState(
      overlay({ hands: [[], [], [TWO_CLUBS, SEVEN_CLUBS], []], turn: 2, tricks_played: 1 }),
    )
    const next = mkState(
      overlay({
        hands: [[], [], [SEVEN_CLUBS], []],
        current_trick: [entry(2, TWO_CLUBS)],
        led_suit: 0,
        turn: 3,
        tricks_played: 1,
      }),
    )
    const move = detectPlay(prev, next, 0)
    expect(move?.player).toBe(2)
    expect(move?.card).toEqual(TWO_CLUBS)
    const sc = computeScene(prev).opponents.find((c) => cardKey(c.card) === cardKey(TWO_CLUBS))
    expect(sc).toBeDefined()
    expect(move?.fromX).toBe((sc?.x ?? 0) + (sc?.w ?? 0) / 2)
    expect(move?.fromW).toBe(sc?.w)
  })

  it('detects the 4th card from last_trick and flags it as completing the trick', () => {
    // Players 1, 2, and 3 have played; player 0 plays the 4th card, which resolves the trick in the same step
    // (current_trick clears, last_trick is set, tricks_played increments).
    const prev = mkState(
      overlay({
        hands: [[THREE_CLUBS], [], [], []],
        current_trick: [entry(1, TWO_CLUBS), entry(2, FOUR_CLUBS), entry(3, SEVEN_CLUBS)],
        led_suit: 0,
        turn: 0,
        tricks_played: 0,
        legal_cards: [THREE_CLUBS],
      }),
    )
    const next = mkState(
      overlay({
        hands: [[], [], [], []],
        current_trick: [],
        last_trick: [
          entry(1, TWO_CLUBS),
          entry(2, FOUR_CLUBS),
          entry(3, SEVEN_CLUBS),
          entry(0, THREE_CLUBS),
        ],
        last_trick_winner: 3,
        turn: 3,
        tricks_played: 1,
      }),
    )
    const move = detectPlay(prev, next, 0)
    expect(move?.player).toBe(0)
    expect(move?.card).toEqual(THREE_CLUBS)
    expect(move?.completesTrick).toBe(true)
    expect(move?.resting).toHaveLength(3) // the three cards already down, no winner highlight yet
    expect(move?.resting.every((c) => !c.isWinner)).toBe(true)
  })

  it('does not fire on no change, a backward scrub, or a null prev', () => {
    const s = mkState(
      overlay({
        hands: [[THREE_CLUBS], [], [], []],
        current_trick: [entry(3, TWO_CLUBS)],
        turn: 0,
      }),
    )
    expect(detectPlay(s, s, 0)).toBeNull()
    expect(detectPlay(null, s, 0)).toBeNull()
    // A rewound trick count (fresh deal / backward jump) is never a "play".
    const high = mkState(overlay({ tricks_played: 5 }))
    const low = mkState(overlay({ tricks_played: 0 }))
    expect(detectPlay(high, low, 0)).toBeNull()
  })

  it('eases from a held source to the center, shrinking to trick size', () => {
    const prev = mkState(
      overlay({
        hands: [[THREE_CLUBS, FOUR_CLUBS], [], [], []],
        current_trick: [entry(3, TWO_CLUBS)],
        led_suit: 0,
        turn: 0,
        tricks_played: 1,
        legal_cards: [THREE_CLUBS, FOUR_CLUBS],
      }),
    )
    const next = mkState(
      overlay({
        hands: [[FOUR_CLUBS], [], [], []],
        current_trick: [entry(3, TWO_CLUBS), entry(0, THREE_CLUBS)],
        turn: 1,
        tricks_played: 1,
      }),
    )
    const move = detectPlay(prev, next, 0)
    if (move === null) {
      throw new Error('no play')
    }
    const start = playCardAt(move, 0)
    expect(start.x).toBe(move.fromX)
    expect(start.y).toBe(move.fromY)
    expect(start.scale).toBe(1)
    // Through the initial hold the flyer stays put (so the eye registers which card was picked).
    expect(playCardAt(move, PLAY_HOLD / 2).x).toBe(move.fromX)
    const end = playCardAt(move, 1)
    expect(end.x).toBeCloseTo(move.toX)
    expect(end.y).toBeCloseTo(move.toY)
  })
})

describe('renderer registration', () => {
  it('registers the Hearts renderer under its metadata key', () => {
    expect(getRenderer('hearts')).toBeDefined()
  })
})
