import type { StepState } from '@game-sandbox/schema'
import { getRenderer } from '@renderers/registry.js'
import { describe, expect, it } from 'vitest'
import { formatSeat } from '../../../frontend/src/lib/format.js'
import {
  type SceneConfig,
  wideSeatsAccessibilityLabel,
} from '../../../frontend/src/renderers/cards/scene.js'
import {
  bidChipAt,
  bidToAction,
  type Card,
  computeScene,
  handCardAt,
  NIL_BID,
  type SpadesScene,
} from './scene.js'
// Importing the barrel registers every renderer, including Spades, so the registration test below can
// look it up by its metadata key the way the host pages do.
import '@renderers/index.js'
// A checked-in slice of a real four-agent Spades recording (header + per-step states), produced by
// scripts/gen_spades_fixture.py through the real harness recording path. Like the Hearts renderer test,
// the determinism fixture doubles as the renderer fixture, so any visual regression has a byte-identical,
// real-shape input carrying the opening bids and all thirteen tricks. `?raw` (Vite) gives the file as a
// string under jsdom.
import fixture from '../../../frontend/test/fixtures/spades-recording.jsonl?raw'

const states: StepState[] = fixture
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .slice(1) // drop the header line
  .map((line) => JSON.parse(line) as StepState)

// Card objects {suit, rank} (rank is the FACE value 2..14). A few named for readable fixtures.
const TWO_CLUBS: Card = { suit: 0, rank: 2 }
const THREE_CLUBS: Card = { suit: 0, rank: 3 }
const FOUR_CLUBS: Card = { suit: 0, rank: 4 }
const FIVE_CLUBS: Card = { suit: 0, rank: 5 }
const TWO_SPADES: Card = { suit: 2, rank: 2 }
const THREE_SPADES: Card = { suit: 2, rank: 3 }
const TWO_HEARTS: Card = { suit: 3, rank: 2 }

/** Every bid 0..13, the full bidding legal-bids list. */
const ALL_BIDS = Array.from({ length: 14 }, (_, k) => k)

const PARTNERSHIP_SEATS: NonNullable<SceneConfig['seats']> = {
  seat_0: ['player_0', 'player_2'],
  seat_1: ['player_1', 'player_3'],
}

const SOLO_SEATS: NonNullable<SceneConfig['seats']> = {
  seat_0: ['player_0'],
  seat_1: ['player_1'],
  seat_2: ['player_2'],
  seat_3: ['player_3'],
}

/** One `{player, card}` trick entry, the shape `current_trick`/`last_trick` carry (play order). */
function entry(player: number, card: Card): { player: number; card: Card } {
  return { player, card }
}

/** Build a minimal StepState carrying a Spades overlay, with the required envelope fields. */
function mkState(overlay: Record<string, unknown>, tick = 0): StepState {
  return {
    schema_version: 1,
    tick,
    agents: {},
    timing: { started_at: tick, duration_ms: 1 },
    overlay,
  }
}

/** A baseline overlay; spread overrides over it for each scenario. */
function overlay(over: Record<string, unknown>): Record<string, unknown> {
  return {
    phase: 'play',
    hands: [[], [], [], []],
    bids: [0, 0, 0, 0],
    current_trick: [],
    last_trick: null,
    last_trick_winner: null,
    turn: 0,
    turn_player: 'player_0',
    trick_leader: 0,
    led_suit: null,
    spades_broken: false,
    tricks_played: 0,
    tricks_won: [0, 0, 0, 0],
    team_scores: [0, 0],
    display_scores: [0, 0, 0, 0],
    leaderboard_scores: [0, 0, 0, 0],
    legal_cards: [],
    legal_bids: [],
    terminal: false,
    ...over,
  }
}

const litCards = (scene: SpadesScene): Card[] =>
  scene.hand.filter((c) => c.legal).map((c) => c.card)
const greyCards = (scene: SpadesScene): Card[] =>
  scene.hand.filter((c) => !c.legal).map((c) => c.card)

describe('the bidding round: the chip grid and the greyed hand', () => {
  it('lights every chip from the full bid mask, marks NIL, and greys the whole hand', () => {
    const state = mkState(
      overlay({
        phase: 'bidding',
        hands: [[TWO_CLUBS, TWO_SPADES, TWO_HEARTS], [], [], []],
        bids: [-1, -1, -1, -1],
        turn: 0,
        legal_bids: ALL_BIDS,
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    const panel = scene.bidPanel
    expect(panel).not.toBeNull()
    if (panel === null) {
      throw new Error('no bid panel')
    }
    // All fourteen chips present, in bid order 0..13, every one enabled by the full mask.
    expect(panel.chips.map((c) => c.bid)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(panel.chips.every((c) => c.enabled)).toBe(true)
    expect(panel.chips.map((c) => c.action)).toEqual(ALL_BIDS.map(bidToAction))
    // Chip 0 is the nil chip; its action is 52 (the nil bid).
    expect(panel.chips[0]?.bid).toBe(NIL_BID)
    expect(panel.chips[0]?.action).toBe(bidToAction(NIL_BID))
    // During bidding no card is legal (you cannot play until you have bid), so the hand is all grey.
    expect(litCards(scene)).toEqual([])
    expect(greyCards(scene)).toEqual([TWO_CLUBS, TWO_SPADES, TWO_HEARTS])
    // The prompt speaks in the first person on the controlled player's own bidding turn.
    expect(panel.prompt).toBe('Choose your bid')
    expect(panel.promptTone).toBe('gold')
  })

  it('enables exactly the chips named by a partial mask', () => {
    const state = mkState(
      overlay({
        phase: 'bidding',
        bids: [-1, -1, -1, -1],
        turn: 0,
        legal_bids: [0, 3],
      }),
    )
    const panel = computeScene(state, { controlledPlayers: ['player_0'] }).bidPanel
    if (panel === null) {
      throw new Error('no bid panel')
    }
    expect(panel.chips.filter((c) => c.enabled).map((c) => c.bid)).toEqual([0, 3])
    // A chip outside the mask is not clickable even on the controlled player's turn.
    expect(panel.chips.filter((c) => c.controllable).map((c) => c.bid)).toEqual([0, 3])
  })
})

describe('the play round: greying the hand from the legal-cards overlay', () => {
  it('follow suit: clubs were led, only the held clubs are legal', () => {
    const state = mkState(
      overlay({
        hands: [[THREE_CLUBS, FOUR_CLUBS, TWO_SPADES, TWO_HEARTS], [], [], []],
        current_trick: [entry(3, FIVE_CLUBS)],
        led_suit: 0,
        turn: 0,
        tricks_played: 2,
        legal_cards: [THREE_CLUBS, FOUR_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(litCards(scene)).toEqual([THREE_CLUBS, FOUR_CLUBS])
    expect(greyCards(scene)).toEqual([TWO_SPADES, TWO_HEARTS])
    expect(scene.bidPanel).toBeNull() // no chips during play
  })

  it('spades not broken on the lead: spades are greyed', () => {
    const state = mkState(
      overlay({
        hands: [[FIVE_CLUBS, TWO_SPADES, THREE_SPADES], [], [], []],
        led_suit: null,
        turn: 0,
        tricks_played: 2,
        spades_broken: false,
        legal_cards: [FIVE_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(litCards(scene)).toEqual([FIVE_CLUBS])
    expect(greyCards(scene)).toEqual([TWO_SPADES, THREE_SPADES])
  })

  it('greys the whole hand when it is not the view player turn (the mask is the other player)', () => {
    const state = mkState(
      overlay({
        hands: [[THREE_CLUBS, FOUR_CLUBS], [FIVE_CLUBS], [], []],
        current_trick: [entry(0, TWO_CLUBS)],
        led_suit: 0,
        turn: 1,
        turn_player: 'player_1',
        tricks_played: 1,
        legal_cards: [FIVE_CLUBS],
      }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    expect(litCards(scene)).toEqual([])
    expect(greyCards(scene)).toEqual([THREE_CLUBS, FOUR_CLUBS])
  })
})

describe('player badges: bids, the NIL marker, tricks won, and partnerships', () => {
  it('reads each player bid/won, flags a waiting player and a nil, and assigns partnerships', () => {
    const state = mkState(
      overlay({
        phase: 'bidding',
        bids: [-1, 3, 0, 5],
        tricks_won: [0, 1, 2, 3],
        turn: 0,
        legal_bids: ALL_BIDS,
      }),
    )
    const scene = computeScene(state)
    expect(scene.players.map((p) => p.bid)).toEqual([-1, 3, 0, 5])
    expect(scene.players.map((p) => p.won)).toEqual([0, 1, 2, 3])
    // Player 0 has not bid; player 2 bid nil (bid 0).
    expect(scene.players[0]?.bid).toBe(-1)
    expect(scene.players.map((p) => p.isNil)).toEqual([false, false, true, false])
    // Partnerships alternate by player parity: players 0 and 2 are team 0, players 1 and 3 are team 1.
    expect(scene.players.map((p) => p.team)).toEqual([0, 1, 0, 1])
  })

  it('tints and labels the two team scores, tagging the controlled partnership "(you)"', () => {
    const state = mkState(
      overlay({ phase: 'bidding', bids: [-1, -1, -1, -1], team_scores: [10, -20], turn: 0 }),
    )
    const scene = computeScene(state, { controlledPlayers: ['player_0'] })
    const ts = scene.status.teamScores
    expect(ts.map((t) => t.label)).toEqual(['P0+P2 (you)', 'P1+P3'])
    expect(ts.map((t) => t.score)).toEqual([10, -20])
    expect(ts.map((t) => t.team)).toEqual([0, 1])
    // The phase indicator and message read the bidding phase in the first person on the controlled turn.
    expect(scene.status.phaseText).toBe('bidding')
    expect(scene.status.message).toBe('Your bid')
  })

  it('marks spades broken and reads the trick counter during play', () => {
    const state = mkState(overlay({ spades_broken: true, tricks_played: 4, turn: 2 }))
    const scene = computeScene(state)
    expect(scene.spadesBroken).toBe(true)
    expect(scene.status.spadesBroken).toBe(true)
    expect(scene.status.phaseText).toBe('trick 5/13')
    // A spectator reads a third-person "to play" message and plain P0..P3 player labels.
    expect(scene.status.message).toBe('P2 to play')
    expect(scene.players.map((p) => p.label)).toEqual(['P0', 'P1', 'P2', 'P3'])
  })

  it.each([
    'player_0',
    'player_1',
    'player_2',
    'player_3',
  ])('derives partnership assignment marks from the recording header for a %s view', (viewer) => {
    const scene = computeScene(mkState(overlay({})), {
      controlledPlayers: [viewer],
      seats: PARTNERSHIP_SEATS,
    })
    const byPlayer = new Map(scene.players.map((player) => [player.player, player]))

    expect(byPlayer.get(0)).toMatchObject({ assignmentSeat: 'seat_0', assignmentGroup: 0 })
    expect(byPlayer.get(2)).toMatchObject({ assignmentSeat: 'seat_0', assignmentGroup: 0 })
    expect(byPlayer.get(1)).toMatchObject({ assignmentSeat: 'seat_1', assignmentGroup: 1 })
    expect(byPlayer.get(3)).toMatchObject({ assignmentSeat: 'seat_1', assignmentGroup: 1 })
    expect(scene.players.map((player) => player.team).sort()).toEqual([0, 0, 1, 1])
  })

  it.each([
    'player_0',
    'player_1',
    'player_2',
    'player_3',
  ])('omits assignment marks for a singleton-only plan from a %s view', (viewer) => {
    const scene = computeScene(mkState(overlay({})), {
      controlledPlayers: [viewer],
      seats: SOLO_SEATS,
    })
    expect(scene.players.every((player) => player.assignmentSeat === null)).toBe(true)
    expect(scene.players.every((player) => player.assignmentGroup === null)).toBe(true)
  })

  it('inherits the shared compact seat labels and wide-seat accessibility description', () => {
    expect(formatSeat('seat_12')).toBe('S12')
    // The wide-seat badge label is formatSeat itself, so a bare (non-numbered) seat name falls back to
    // formatSeat's own readable title-casing rather than a bespoke identity fallback.
    expect(formatSeat('north')).toBe('North')
    expect(wideSeatsAccessibilityLabel('Spades', PARTNERSHIP_SEATS)).toBe(
      'Spades table. Wide seats: S0 includes P0 and P2; S1 includes P1 and P3.',
    )
    expect(wideSeatsAccessibilityLabel('Spades', SOLO_SEATS)).toBeNull()
  })
})

describe('hit-testing (bid chips and hand cards)', () => {
  it('resolves a point in a chip to its bid action, and a miss to null', () => {
    const state = mkState(
      overlay({ phase: 'bidding', bids: [-1, -1, -1, -1], turn: 0, legal_bids: ALL_BIDS }),
    )
    const panel = computeScene(state, { controlledPlayers: ['player_0'] }).bidPanel
    if (panel === null) {
      throw new Error('no bid panel')
    }
    for (const bid of [0, 6, 7, 13]) {
      const chip = panel.chips[bid]
      if (chip === undefined) {
        throw new Error(`no chip ${bid}`)
      }
      const hit = bidChipAt(panel, chip.x + chip.w / 2, chip.y + chip.h / 2)
      expect(hit?.action).toBe(bidToAction(bid))
    }
    // A point clear of the grid hits nothing.
    expect(bidChipAt(panel, 0, 0)).toBeNull()
  })

  it('hit-tests a hand card front-most first', () => {
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
    const last = scene.hand[scene.hand.length - 1]
    if (last === undefined) {
      throw new Error('empty hand')
    }
    const hit = handCardAt(scene.hand, last.x + last.w / 2, last.y + last.h / 2)
    expect(hit?.card).toBe(last.card)
    expect(handCardAt(scene.hand, last.x, -5)).toBeNull()
  })
})

describe('controllability and the move clock (live vs replay)', () => {
  it('makes chips controllable only on the controlled player turn, and never in replay', () => {
    const bidding = (over: Record<string, unknown>): Record<string, unknown> =>
      overlay({ phase: 'bidding', bids: [-1, -1, -1, -1], legal_bids: ALL_BIDS, ...over })

    // Controlled player, its turn: every masked chip is clickable.
    const mine = computeScene(mkState(bidding({ turn: 0 })), {
      controlledPlayers: ['player_0'],
    }).bidPanel
    expect(mine?.chips.every((c) => c.controllable)).toBe(true)

    // Controlled player, but another player is bidding: chips draw (enabled) but none is clickable.
    const other = computeScene(mkState(bidding({ turn: 1, turn_player: 'player_1' })), {
      controlledPlayers: ['player_0'],
    }).bidPanel
    expect(other?.chips.every((c) => c.enabled)).toBe(true)
    expect(other?.chips.some((c) => c.controllable)).toBe(false)
    expect(other?.prompt).toBe('P1 is bidding')

    // Replay / spectator (no controlled player ids): the panel still draws but nothing is clickable.
    const replay = computeScene(mkState(bidding({ turn: 0 }))).bidPanel
    expect(replay?.chips.some((c) => c.controllable)).toBe(false)
  })

  it('routes a partner bid to the acting player and names that hand in the status', () => {
    const scene = computeScene(
      mkState(
        overlay({
          phase: 'bidding',
          bids: [3, -1, -1, -1],
          turn: 2,
          turn_player: 'player_2',
          legal_bids: ALL_BIDS,
        }),
      ),
      { controlledPlayers: ['player_0', 'player_2'] },
    )

    expect(scene.status.message).toBe('Your bid (P2)')
    // The panel above the chips names the acting hand too, so the two prompts never disagree.
    expect(scene.bidPanel?.prompt).toBe('Choose your bid (P2)')
    expect(scene.bidPanel?.chips.every((chip) => chip.player === 2)).toBe(true)
    expect(scene.bidPanel?.chips.every((chip) => chip.controllable)).toBe(true)
  })

  it('names the acting partner during play', () => {
    const scene = computeScene(
      mkState(
        overlay({
          hands: [[], [], [TWO_CLUBS], []],
          turn: 2,
          turn_player: 'player_2',
          legal_cards: [TWO_CLUBS],
        }),
      ),
      { controlledPlayers: ['player_0', 'player_2'] },
    )

    expect(scene.status.message).toBe('Your turn (P2)')
  })

  it('shows the move clock only on the controlled human turn (bidding counts), never in replay', () => {
    const onTurn = overlay({
      phase: 'bidding',
      bids: [-1, -1, -1, -1],
      turn: 0,
      legal_bids: ALL_BIDS,
    })
    expect(
      computeScene(mkState(onTurn), { controlledPlayers: ['player_0'], humanTimeoutMs: 60_000 })
        .moveClock?.totalMs,
    ).toBe(60_000)
    expect(computeScene(mkState(onTurn), { humanTimeoutMs: 60_000 }).moveClock).toBeNull()

    const partnerTurn = { ...onTurn, turn: 2, turn_player: 'player_2' }
    expect(
      computeScene(mkState(partnerTurn), {
        controlledPlayers: ['player_0', 'player_2'],
        humanTimeoutMs: 60_000,
      }).moveClock,
      // The clock names the player on it, so the host can say who holds the controls.
    ).toEqual({ x: 480, y: 173, totalMs: 60_000, player: 'player_2' })
  })
})

describe('the recorded multi-agent Spades replay', () => {
  it('opens with a bidding round: a chip panel and an empty centre until play begins', () => {
    const biddingFrames = states.filter(
      (s) => (s.overlay as Record<string, unknown>).phase === 'bidding',
    )
    expect(biddingFrames.length).toBeGreaterThanOrEqual(3) // players bid in turn before play opens
    for (const state of biddingFrames) {
      const scene = computeScene(state)
      expect(scene.bidPanel).not.toBeNull()
      expect(scene.trick).toHaveLength(0) // no trick during the bid round
    }
    // Once play begins the chip panel is gone.
    const playFrames = states.filter((s) => (s.overlay as Record<string, unknown>).phase === 'play')
    for (const state of playFrames) {
      expect(computeScene(state).bidPanel).toBeNull()
    }
  })

  it('replays trick by trick: the centre grows to four then resets, with a winner on completion', () => {
    let completedTricks = 0
    for (const state of states) {
      const o = state.overlay as Record<string, unknown>
      if (o.phase !== 'play') {
        continue
      }
      const scene = computeScene(state)
      const currentLen = (o.current_trick as unknown[]).length
      if (currentLen > 0) {
        expect(scene.trick).toHaveLength(currentLen)
        expect(scene.trick.every((c) => !c.isWinner)).toBe(true)
      } else if (o.last_trick !== null) {
        expect(scene.trick).toHaveLength(4)
        expect(scene.trick.filter((c) => c.isWinner)).toHaveLength(1)
        expect(scene.trick.find((c) => c.isWinner)?.player).toBe(o.last_trick_winner)
        completedTricks++
      }
    }
    expect(completedTricks).toBe(13) // a full hand is thirteen tricks
  })

  it('ends with consistent bids/tricks and partner-equal team scores', () => {
    const terminal = states.at(-1)
    if (terminal === undefined) {
      throw new Error('fixture has no states')
    }
    const scene = computeScene(terminal)
    expect(scene.terminal).toBe(true)
    expect(scene.status.message).toBe('Game over')
    expect(scene.hand).toHaveLength(0) // every card has been played
    // Thirteen tricks were taken across the four players.
    const wonTotal = scene.players.reduce((sum, p) => sum + p.won, 0)
    expect(wonTotal).toBe(13)
    // Partners share a team score, so the two players of each team read equal leaderboard scores.
    const lb = (terminal.overlay as Record<string, unknown>).leaderboard_scores as number[]
    expect(lb[0]).toBe(lb[2])
    expect(lb[1]).toBe(lb[3])
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

describe('renderer registration', () => {
  it('registers the Spades renderer under its metadata key', () => {
    expect(getRenderer('spades')).toBeDefined()
  })
})
