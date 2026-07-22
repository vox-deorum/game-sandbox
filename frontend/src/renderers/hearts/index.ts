/**
 * The Hearts renderer: a {@link CardTableRenderer} subclass that supplies only what is Hearts and not
 * generic trick-taking — the overlay→scene function, the seat badge's penalty-score line, the
 * hearts-broken status strip, and the "+N points" pill raised over a trick's winner. The shared card
 * table (felt, seats, trick, hand, opponents, card faces, and the fly-in/sweep animation) lives in
 * {@link CardTableRenderer}.
 *
 * The same class runs unchanged from a stored recording, where it has no `sendAction` and no controlled
 * slot, so the cards are inert and it is draw-only (what the replay viewer relies on). It registers under
 * the metadata key `"hearts"` (see `renderers/index.ts`).
 *
 * Hearts-specific drawing stays here while the shared trick-taking table remains in the base class.
 */
import type { StepState } from '@game-sandbox/schema'
import { type Container, Graphics } from 'pixi.js'

import { CardTableRenderer } from '../cards/CardTableRenderer.js'
import {
  COLORS,
  cardPoints,
  computeScene,
  DEFAULT_GEOMETRY,
  HEARTS,
  type HeartsScene,
  type SceneSeat,
  type TableGeometry,
  type TrickSweep,
  WIDTH,
} from './scene.js'

export class HeartsRenderer extends CardTableRenderer<HeartsScene> {
  protected readonly geometry: TableGeometry = DEFAULT_GEOMETRY

  protected computeSceneFor(state: StepState): HeartsScene {
    return computeScene(state, this.sceneConfig())
  }

  // Hearts declares no base input intents: the shared hand wires on-screen card clicks per card, so it
  // inherits the base `inputs()` default of [].

  /** The seat badge interior: the "(you)"-aware name and the seat's running penalty score. */
  protected drawSeatContent(container: Container, seat: SceneSeat): void {
    const label = this.text(seat.label, 22, COLORS.white, 'center')
    label.position.set(0, -11)
    container.addChild(label)
    const score = this.text(
      `${seat.score} pts`,
      18,
      seat.isTurn ? COLORS.gold : COLORS.dim,
      'center',
    )
    score.position.set(0, 13)
    container.addChild(score)
  }

  /** The gold "+N points" pill over the trick winner during the sweep, or none for a pointless trick. */
  protected override sweepPillText(sweep: TrickSweep): string | null {
    const points = sweep.cards.reduce((sum, c) => sum + cardPoints(c.card), 0)
    return points > 0 ? `+${points}` : null
  }

  // --- Status strip ---

  protected reconcileStatus(scene: HeartsScene): void {
    // The base clears the status layer before calling this; we just build the two rows.
    // Tall enough to hold both rows. A shorter panel clips the hint row.
    this.statusLayer.addChild(this.makeStatusPanel(60))

    const s = scene.status
    const trick = this.text(s.trickText, 22, COLORS.white, 'left')
    trick.position.set(16, 9)
    this.statusLayer.addChild(trick)

    // Hearts-broken indicator: a small heart pip (red when broken, muted otherwise) plus a label.
    const hx = 16 + trick.width + 26
    const hy = 9 + trick.height / 2
    const heart = new Graphics()
    this.drawSuit(heart, HEARTS, hx, hy, 15, s.heartsBroken ? COLORS.redInk : '#5c7066')
    this.statusLayer.addChild(heart)
    const hb = this.text(
      s.heartsBroken ? 'hearts broken' : 'hearts intact',
      18,
      s.heartsBroken ? COLORS.white : COLORS.dim,
      'left',
    )
    hb.position.set(hx + 14, 11)
    this.statusLayer.addChild(hb)

    const msg = this.text(
      s.message,
      22,
      s.messageTone === 'gold' ? COLORS.gold : COLORS.white,
      'right',
    )
    msg.position.set(WIDTH - 16, 9)
    this.statusLayer.addChild(msg)

    if (s.hint) {
      const hint = this.text(s.hint, 18, COLORS.hintInk, 'left')
      // Sit just under the first row; the small gap keeps the hint inside the panel.
      hint.position.set(16, 9 + trick.height + 2)
      this.statusLayer.addChild(hint)
    }
    // The end-of-match leaderboard is host chrome now (GameOverCard.vue / scripts/play.py), not drawn
    // into the canvas; the strip's "Game over" message (s.message) is the renderer's only terminal note.
  }
}
