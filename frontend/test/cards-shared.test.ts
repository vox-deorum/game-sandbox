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
import { PixiRenderer } from '../src/renderers/base/PixiRenderer.js'
import { CardTableRenderer } from '../src/renderers/cards/CardTableRenderer.js'
import {
  cardKey,
  cardToAction,
  DEFAULT_GEOMETRY,
  HEIGHT,
  NUM_PLAYERS,
  RANK_LABELS,
  rankLabel,
  WIDTH,
} from '../src/renderers/cards/scene.js'

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
})
