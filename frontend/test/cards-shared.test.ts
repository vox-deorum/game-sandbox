import type { StepState } from '@game-sandbox/schema'
import type { RendererContext } from '@renderers/types.js'
import { describe, expect, it } from 'vitest'
import { HeartsRenderer } from '../../environments/hearts/renderer/index.js'
// The Hearts scene module re-exports the whole shared layer, so importing the frame constants from it
// must yield the same values as importing them from the shared module (the single-source-of-truth rule
// both card games rely on). Aliased so the two can be compared.
import {
  HEIGHT as HEARTS_HEIGHT,
  WIDTH as HEARTS_WIDTH,
} from '../../environments/hearts/renderer/scene.js'
import { SpadesRenderer } from '../../environments/spades/renderer/index.js'
import { SPADES_GEOMETRY } from '../../environments/spades/renderer/scene.js'
import { formatSeat } from '../src/lib/format.js'
import { PixiRenderer } from '../src/renderers/base/PixiRenderer.js'
import { CardTableRenderer } from '../src/renderers/cards/CardTableRenderer.js'
import {
  buildHand,
  buildMoveClock,
  buildOpponents,
  cardKey,
  cardToAction,
  DEFAULT_GEOMETRY,
  HEIGHT,
  handFanGeometry,
  NUM_PLAYERS,
  playerOfId,
  positionAnchor,
  positionOfPlayer,
  RANK_LABELS,
  rankLabel,
  readCardOverlay,
  resolveView,
  WIDTH,
  wideSeatAssignments,
  wideSeatsAccessibilityLabel,
} from '../src/renderers/cards/scene.js'
import { heartsMeta, spadesHeader } from './helpers/fixtures.js'

// The shared card-table layer is a single source both card renderers extend, its codec agrees with the
// rules encoding, and the per-game geometry
// stays a hook. These are cheap, canvas-free invariants (no renderer is mounted).

describe('the shared card-table renderer layer', () => {
  it('has both the shared class and each game renderer in one inheritance chain', () => {
    // CardTableRenderer sits between the game renderers and the generic PixiRenderer base.
    expect(CardTableRenderer.prototype instanceof PixiRenderer).toBe(true)
    expect(HeartsRenderer.prototype instanceof CardTableRenderer).toBe(true)
    // Spades extends the same shared class, so both games share every table primitive.
    expect(SpadesRenderer.prototype instanceof CardTableRenderer).toBe(true)
  })

  it('agrees with the card codec across all 52 cards', () => {
    // engine id = suit * 13 + (rank - 2), suits 0..3, FACE ranks 2..14 — card_utils.card_to_obj's shape.
    for (let engineId = 0; engineId < 52; engineId++) {
      const suit = Math.floor(engineId / 13)
      const rank = (engineId % 13) + 2
      const card = { suit, rank }
      // Round-trip: cardToAction reconstructs the engine id from the object.
      expect(cardToAction(card)).toBe(engineId)
      // cardKey is a stable, unique identity per card.
      expect(cardKey(card)).toBe(`${suit}:${rank}`)
      // rankLabel reads the FACE rank (2..14) into the same 0-indexed RANK_LABELS table.
      expect(rankLabel(card)).toBe(RANK_LABELS[rank - 2])
    }
    expect(RANK_LABELS).toHaveLength(13)
    expect(NUM_PLAYERS).toBe(4)
  })

  it('pins the table frame and re-exports it identically through the Hearts module', () => {
    expect(WIDTH).toBe(960)
    expect(HEIGHT).toBe(720)
    // The Hearts entry point forwards the shared constants unchanged.
    expect(HEARTS_WIDTH).toBe(WIDTH)
    expect(HEARTS_HEIGHT).toBe(HEIGHT)
  })

  it('uses one stable fan geometry for every view-player hand', () => {
    expect(handFanGeometry(1)).toEqual({ startX: 448, step: 0 })
    expect(handFanGeometry(13)).toEqual({ startX: 40, step: 68 })
  })

  it('keeps table geometry a per-game hook with each game overriding the same fields', () => {
    // Hearts uses the shared defaults; Spades overrides these same fields with taller badges and a
    // deeper side inset, so the values are a data hook, not hard-coded layout.
    expect(DEFAULT_GEOMETRY).toEqual({
      northBadgeY: 101,
      opponentRowNorthY: 150,
      badgeW: 158,
      badgeH: 56,
      sideBadgeInset: 130,
    })
    expect(SPADES_GEOMETRY).toEqual({
      northBadgeY: 117,
      opponentRowNorthY: 166,
      badgeW: 168,
      badgeH: 62,
      sideBadgeInset: 176,
    })
  })

  it('parses stable player ids and rotates every player around each viewer', () => {
    expect(playerOfId('player_0')).toBe(0)
    expect(playerOfId('player_3')).toBe(3)

    expect([0, 1, 2, 3].map((player) => positionOfPlayer(player, 0))).toEqual([0, 1, 2, 3])
    expect([0, 1, 2, 3].map((player) => positionOfPlayer(player, 1))).toEqual([3, 0, 1, 2])
    expect([0, 1, 2, 3].map((player) => positionOfPlayer(player, 2))).toEqual([2, 3, 0, 1])
    expect([0, 1, 2, 3].map((player) => positionOfPlayer(player, 3))).toEqual([1, 2, 3, 0])
  })

  it('keeps the four visual positions stable and separate from player numbers', () => {
    expect(positionAnchor(0)).toEqual({ x: WIDTH / 2, y: HEIGHT - 150 })
    expect(positionAnchor(1)).toEqual({ x: DEFAULT_GEOMETRY.sideBadgeInset, y: HEIGHT / 2 })
    expect(positionAnchor(2)).toEqual({ x: WIDTH / 2, y: DEFAULT_GEOMETRY.northBadgeY })
    expect(positionAnchor(3)).toEqual({ x: WIDTH - DEFAULT_GEOMETRY.sideBadgeInset, y: HEIGHT / 2 })
  })

  it('keeps every controlled player while anchoring the view to the first', () => {
    const state: StepState = {
      schema_version: 1,
      tick: 0,
      agents: {},
      timing: { started_at: 0, duration_ms: 1 },
      overlay: {
        hands: [[], [], [{ suit: 0, rank: 2 }], []],
        current_trick: [{ player: 1, card: { suit: 2, rank: 14 } }],
        last_trick: null,
        last_trick_winner: null,
        turn: 2,
        turn_player: 'player_2',
        trick_leader: 1,
        led_suit: 2,
        tricks_played: 1,
        legal_cards: [{ suit: 0, rank: 2 }],
        terminal: false,
      },
    }
    const overlay = readCardOverlay(state)
    expect(overlay.turnPlayerId).toBe('player_2')
    expect(overlay.currentTrick).toEqual([{ player: 1, card: { suit: 2, rank: 14 } }])

    const view = resolveView({ controlledPlayers: ['player_2', 'player_0'] })
    expect(view).toEqual({ viewPlayer: 2, controlledPlayers: [2, 0], revealAll: false })
    expect(buildHand(overlay, view, new Set(['0:2']))[0]?.controllable).toBe(true)
    expect(
      buildHand(overlay, { ...view, controlledPlayers: [] }, new Set(['0:2']))[0]?.controllable,
    ).toBe(false)

    const partnerTurn = {
      ...overlay,
      hands: [[{ suit: 0, rank: 3 }], [], [{ suit: 0, rank: 2 }], []],
      turn: 0,
      turnPlayerId: 'player_0',
      legalCards: [{ suit: 0, rank: 3 }],
    }
    expect(buildOpponents(partnerTurn, view, new Set(['0:3']), DEFAULT_GEOMETRY)).toEqual([
      expect.objectContaining({
        player: 0,
        card: { suit: 0, rank: 3 },
        faceUp: true,
        controlled: true,
        legal: true,
        controllable: true,
      }),
    ])
    expect(buildMoveClock(partnerTurn, view, 60_000)).toEqual({ x: WIDTH / 2, y: 157, seconds: 60 })

    // A partner along a side edge shifts the clock inward instead, since those badges already sit at
    // the table's vertical centre.
    const westTurn = { ...partnerTurn, turn: 3, turnPlayerId: 'player_3' }
    const westView = { ...view, controlledPlayers: [2, 3] }
    expect(buildMoveClock(westTurn, westView, 60_000)).toEqual({
      x: DEFAULT_GEOMETRY.sideBadgeInset + 56,
      y: HEIGHT / 2,
      seconds: 60,
    })
  })

  it('derives only wide-seat groups and uses the shared compact and accessible labels', () => {
    const seats: NonNullable<Parameters<typeof wideSeatAssignments>[0]> = {
      seat_0: ['player_0', 'player_2'],
      seat_1: ['player_1'],
      seat_2: ['player_3'],
    }
    expect([...wideSeatAssignments(seats)]).toEqual([
      ['player_0', { seat: 'seat_0', group: 0 }],
      ['player_2', { seat: 'seat_0', group: 0 }],
    ])
    // The wide-seat badge label is formatSeat itself now, not a bespoke copy, so a bare (non-numbered)
    // seat name gets formatSeat's own readable title-cased fallback rather than passing through as-is.
    expect(formatSeat('seat_12')).toBe('S12')
    expect(formatSeat('captain')).toBe('Captain')
    expect(wideSeatsAccessibilityLabel('Hearts', seats)).toBe(
      'Hearts table. Wide seats: S0 includes P0 and P2.',
    )
    expect(wideSeatsAccessibilityLabel('Hearts', { seat_0: ['player_0'] })).toBeNull()
  })

  it('gives every card renderer the shared wide-seat accessibility lifecycle', () => {
    const container = document.createElement('div')
    const context: RendererContext = {
      container,
      meta: heartsMeta(),
      header: spadesHeader(),
      controlledPlayers: [],
    }
    const renderer = HeartsRenderer.mount(context)

    expect(container).toHaveAttribute('role', 'img')
    expect(container).toHaveAttribute(
      'aria-label',
      'Hearts table. Wide seats: S0 includes P0 and P2; S1 includes P1 and P3.',
    )

    renderer.destroy()
    expect(container).not.toHaveAttribute('role')
    expect(container).not.toHaveAttribute('aria-label')
  })
})
