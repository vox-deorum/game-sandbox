import { describe, expect, it } from 'vitest'

import { PixiRenderer } from '../src/renderers/base/PixiRenderer.js'
import { CardTableRenderer } from '../src/renderers/cards/CardTableRenderer.js'
import {
  DEFAULT_GEOMETRY,
  HEIGHT,
  NUM_PLAYERS,
  RANK_LABELS,
  rankOf,
  suitOf,
  WIDTH,
} from '../src/renderers/cards/scene.js'
import { HeartsRenderer } from '../src/renderers/hearts/index.js'
// The Hearts scene module re-exports the whole shared layer, so importing the frame constants from it
// must yield the same values as importing them from the shared module (the single-source-of-truth rule
// the pixel/pygame ports both rely on). Aliased so the two can be compared.
import { HEIGHT as HEARTS_HEIGHT, WIDTH as HEARTS_WIDTH } from '../src/renderers/hearts/scene.js'

// The frontend twin of environments/tests/test_render_shared.py: the shared card-table layer is a single
// source both card renderers extend, its codec agrees with the rules encoding, and the per-game geometry
// stays a hook. These are cheap, canvas-free invariants (no renderer is mounted).

describe('the shared card-table renderer layer', () => {
  it('has both the shared class and each game renderer in one inheritance chain', () => {
    // CardTableRenderer sits between the game renderers and the generic PixiRenderer base.
    expect(CardTableRenderer.prototype instanceof PixiRenderer).toBe(true)
    expect(HeartsRenderer.prototype instanceof CardTableRenderer).toBe(true)
    // (Spades' renderer joins this chain in step 3's Part B.)
  })

  it('agrees with the card codec across all 52 cards', () => {
    // card = suit * 13 + rank, suits 0..3, ranks 0..12 — the encoding rules.py emits.
    for (let card = 0; card < 52; card++) {
      expect(suitOf(card)).toBe(Math.floor(card / 13))
      expect(rankOf(card)).toBe(card % 13)
      // Round-trip: the two halves reconstruct the card id.
      expect(suitOf(card) * 13 + rankOf(card)).toBe(card)
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

  it('keeps table geometry a per-game hook with the Hearts defaults', () => {
    // Hearts uses the shared defaults; Spades overrides these same fields (Part B), so the values are a
    // data hook, not hard-coded layout.
    expect(DEFAULT_GEOMETRY).toEqual({
      northBadgeY: 101,
      opponentRowNorthY: 150,
      badgeW: 158,
      badgeH: 56,
      sideBadgeInset: 130,
    })
  })
})
