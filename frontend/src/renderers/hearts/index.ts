/**
 * The Hearts renderer: a {@link PixiRenderer} subclass that draws each recorded state from the per-step
 * overlay and, during live human play, turns a click on a legal card into the play action for the
 * controlled slot. The same class runs unchanged from a stored recording, where it has no `sendAction`
 * and no controlled slot, so the cards are inert and it is draw-only (what the replay viewer relies on).
 *
 * It keeps the pure/retained split the architecture rests on: {@link computeScene} (in scene.ts) is a
 * pure function of state that produces the static "snapped" table a scrubber lands on, and this class
 * reconciles the retained PixiJS scene graph toward it. On top of that static frame it animates the one
 * transition that carries real game meaning, the trick-won sweep, off the base class's per-frame ticker.
 * Because the animation is driven by a wall-clock budget the host supplies (the replay cadence, a live
 * default, or zero to snap), it replays at replay-time scale rather than breaking the scrubber.
 *
 * This is the browser twin of the Python pygame renderer in `environments/src/hearts/render.py`. They
 * draw the same overlay and must stay in lockstep; scene.ts carries the layout cross-references, and the
 * card/suit/table drawing below mirrors `render.py`'s `_draw_card_face`, `_draw_suit_shapes`,
 * `_draw_seats`, and `_animate_trick_won`. It registers under the metadata key `"hearts"` (see
 * `renderers/index.ts`).
 */
import type { StepState } from '@game-sandbox/schema'
import { Container, FillGradient, Graphics, Rectangle, Text } from 'pixi.js'

import { PixiRenderer } from '../base/PixiRenderer.js'
import type { RenderOptions } from '../types.js'
import {
  COLORS,
  computeScene,
  DIAMONDS,
  detectPlay,
  detectSweep,
  HEARTS,
  HEIGHT,
  type HeartsScene,
  PLAY_HOLD,
  type PlayMove,
  playCardAt,
  RANK_LABELS,
  rankOf,
  type SceneCard,
  type SceneHandCard,
  type SceneSeat,
  type SceneTrickCard,
  SMALL_H,
  SMALL_W,
  SPADES,
  SWEEP_HOLD,
  smoothstep,
  suitOf,
  sweepCardAt,
  type TrickSweep,
  WIDTH,
} from './scene.js'

/** The natural trick-won sweep length in live play (ms); a replay scales it to fit its cadence. */
const SWEEP_NATURAL_MS = 700
/** The slowest and fastest a sweep is ever allowed to run, so a long or tiny budget still reads. */
const SWEEP_MIN_MS = 220
/** The natural card-play fly-in length in live play (ms); a replay scales it to a slice of cadence. */
const PLAY_NATURAL_MS = 480
/** The slowest and fastest a fly-in is ever allowed to run, so a long or tiny budget still reads. */
const PLAY_MIN_MS = 180
/** The active-seat glow's breathing period (ms): a gentle pulse, the only ambient animation. */
const PULSE_PERIOD_MS = 1100
/** How far (px) a hovered hand card lifts, so the user sees which card is under the cursor. */
const HOVER_LIFT = 8

/** A card-play fly-in phase: one card sliding from its player's hand into the center. */
interface PlayPhase {
  kind: 'play'
  move: PlayMove
  elapsedMs: number
  durationMs: number
}

/** A trick-won sweep phase: the four cards sliding into the winner. */
interface SweepPhase {
  kind: 'sweep'
  sweep: TrickSweep
  elapsedMs: number
  durationMs: number
}

/**
 * The center's running transition. A play fly-in (cards 1–3) runs alone; the fourth card's fly-in
 * carries a `nextSweep` to chain into once it lands, since playing the fourth card resolves the trick
 * in the same step (see scene.ts `detectPlay`). A bare trick-won sweep has phase `sweep` and no chain.
 */
interface ActiveTransition {
  phase: PlayPhase | SweepPhase
  nextSweep: SweepPhase | null
}

export class HeartsRenderer extends PixiRenderer {
  // 960x720 is the pinned table size (see scene.ts), a 4:3 landscape, so the host seats the decision
  // log below the canvas rather than beside it.
  readonly internalSize = { width: WIDTH, height: HEIGHT } as const
  // This renderer animates the trick sweep and an ambient seat-glow pulse off the base's ticker.
  protected override readonly animated = true

  /** Persistent layers, painted back-to-front. Built once in {@link setup}. */
  private bgLayer!: Container
  private seatLayer!: Container
  private opponentLayer!: Container
  private trickLayer!: Container
  private handLayer!: Container
  private flyLayer!: Container
  private statusLayer!: Container
  private clockLayer!: Container
  private pointsLayer!: Container

  /** The scene the static layers were last reconciled to, reused by the per-frame loop. */
  private scene: HeartsScene | null = null
  /** The previously rendered state, so {@link detectSweep}/{@link detectPlay} can spot a transition. */
  private lastState: StepState | null = null
  /** The running center transition (a play fly-in and/or trick sweep), or null when drawn statically. */
  private active: ActiveTransition | null = null
  /** Accumulated wall-clock time driving the ambient active-seat pulse. */
  private pulseMs = 0
  /** Cached gradient for the felt backdrop (one GPU texture, freed in destroy). */
  private feltGradient: FillGradient | null = null

  protected setup(root: Container): void {
    this.bgLayer = new Container()
    this.seatLayer = new Container()
    this.opponentLayer = new Container()
    this.trickLayer = new Container()
    this.handLayer = new Container()
    this.flyLayer = new Container()
    this.statusLayer = new Container()
    this.clockLayer = new Container()
    this.pointsLayer = new Container()
    for (const layer of [
      this.bgLayer,
      this.seatLayer,
      this.opponentLayer,
      this.trickLayer,
      this.handLayer,
      // The fly-in's airborne card sits above the hand so it lifts cleanly off the fan (the static
      // trick and resting cards stay in trickLayer below).
      this.flyLayer,
      this.statusLayer,
      this.clockLayer,
      this.pointsLayer,
    ]) {
      root.addChild(layer)
    }
    // Opt the interaction chain in so a click on a hand card hit-tests: the PixiJS event system only
    // recurses into a subtree whose ancestors are interactive, and the stage/root default to inert.
    this.enableInteraction(root)
    this.drawTable()
  }

  /** Make the stage and root pass pointer events down to the interactive hand cards below. */
  private enableInteraction(root: Container): void {
    root.eventMode = 'passive'
    root.interactiveChildren = true
    const stage = root.parent
    if (stage !== null) {
      stage.eventMode = 'static'
      stage.interactiveChildren = true
    }
  }

  override destroy(): void {
    this.feltGradient?.destroy()
    this.feltGradient = null
    super.destroy()
  }

  // Hearts declares no base input intents: it wires on-screen card clicks per card (see makeHandCard),
  // so it inherits the base `inputs()` default of [].

  protected update(state: StepState, options?: RenderOptions): void {
    const config = {
      controlledSlots: this.ctx.controlledSlots,
      humanTimeoutMs: this.ctx.meta.human_timeout_ms,
    }
    const scene = computeScene(state, config)
    this.scene = scene

    // A scrub or seek snaps, so it never animates; otherwise a newly-played card kicks off a fly-in
    // and a newly-completed trick kicks off the sweep.
    const snap = options?.snap === true
    const play = snap ? null : detectPlay(this.lastState, state, scene.viewSeat)
    const sweep = snap ? null : detectSweep(this.lastState, state, scene.viewSeat)

    // Static layers: rebuilt wholesale each state. Seats, status, and clock always reflect the new
    // state; the hand and opponent rows are held at the previous layout during a fly-in (below).
    this.reconcileSeats(scene)
    this.reconcileStatus(scene)
    this.reconcileClock(scene)

    if (play !== null && this.lastState !== null) {
      // Hold the source hand/row at its previous layout for the fly-in, so the other cards don't
      // re-fan to close the gap while one card flies out: the played card's slot stays a placeholder
      // (the flyer fills it during the hold, then leaves it empty as it slides). The held cards are
      // made inert; the hand re-fans to the new, smaller layout once the fly-in lands (see onFrame).
      const before = computeScene(this.lastState, config)
      this.reconcileHand(
        before.hand.filter((c) => c.card !== play.card).map((c) => ({ ...c, controllable: false })),
        scene.viewSeat,
      )
      this.reconcileOpponents(before.opponents.filter((c) => c.card !== play.card))
      // The fourth card resolves the trick in the same step, so its fly-in chains into the sweep;
      // cards 1–3 have no sweep to chain to. When it chains, both phases are sized from one shared
      // budget so the fly-in plus the sweep finish inside the replay cadence (see playPhaseDurations).
      const chained = play.completesTrick && sweep !== null
      const { playMs, sweepMs } = playPhaseDurations(options, chained)
      this.active = {
        phase: { kind: 'play', move: play, elapsedMs: 0, durationMs: playMs },
        nextSweep: chained ? { kind: 'sweep', sweep, elapsedMs: 0, durationMs: sweepMs } : null,
      }
      this.renderPlay(play, 0)
    } else {
      // No fly-in this state: settle the hand/opponents and clear any airborne card from a fly-in that
      // an immediate snap/seek interrupted.
      clear(this.flyLayer)
      this.reconcileHand(scene.hand, scene.viewSeat)
      this.reconcileOpponents(scene.opponents)
      if (sweep !== null) {
        this.active = {
          phase: { kind: 'sweep', sweep, elapsedMs: 0, durationMs: sweepDuration(options) },
          nextSweep: null,
        }
        this.renderSweep(sweep, 0)
      } else {
        this.active = null
        clear(this.pointsLayer)
        this.reconcileTrick(scene.trick)
      }
    }

    this.lastState = state
  }

  protected override onFrame(dtMs: number): boolean {
    if (this.scene === null) {
      return false
    }
    this.pulseMs += dtMs

    const active = this.active
    if (active !== null) {
      const phase = active.phase
      phase.elapsedMs += dtMs
      const t = phase.elapsedMs / phase.durationMs
      if (phase.kind === 'play') {
        // Drive the fly-in: hold-then-slide the card into the center. When it lands, re-fan the held
        // hand/row into the new layout (the placeholder closes), then chain into the queued sweep (the
        // fourth card) or settle the card into the static trick (cards 1–3).
        if (t >= 1) {
          clear(this.flyLayer)
          this.reconcileHand(this.scene.hand, this.scene.viewSeat)
          this.reconcileOpponents(this.scene.opponents)
          if (active.nextSweep !== null) {
            active.phase = active.nextSweep
            active.nextSweep = null
            this.renderSweep(active.phase.sweep, 0)
          } else {
            this.active = null
            this.reconcileTrick(this.scene.trick)
          }
        } else {
          this.renderPlay(phase.move, t)
        }
      } else {
        // Drive the trick-won sweep: slide and shrink the cards into the winner, then leave the center
        // clear (the cards are "with" the winner now), exactly as render.py's _animate_trick_won ends.
        if (t >= 1) {
          this.active = null
          clear(this.trickLayer)
          clear(this.pointsLayer)
        } else {
          this.renderSweep(phase.sweep, t)
        }
      }
    }

    // Ambient: breathe the active seat's glow. Pulsing keeps the loop alive until the hand ends.
    this.pulseActiveSeat()
    return this.active !== null || !this.scene.terminal
  }

  // --- Table backdrop (built once; render.py _build_background) ---

  private drawTable(): void {
    const g = new Graphics()
    // Vertical felt wash, top lighter than bottom.
    this.feltGradient = new FillGradient({
      type: 'linear',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: COLORS.feltTop },
        { offset: 1, color: COLORS.feltBottom },
      ],
      textureSpace: 'local',
    })
    g.rect(0, 0, WIDTH, HEIGHT).fill(this.feltGradient)
    // A soft vignette: two large translucent dark ellipses pull the eye to the lit center.
    g.ellipse(WIDTH / 2, HEIGHT / 2, WIDTH * 0.72, HEIGHT * 0.72).fill({
      color: '#000000',
      alpha: 0.16,
    })
    g.ellipse(WIDTH / 2, HEIGHT / 2, WIDTH * 0.6, HEIGHT * 0.58).fill({
      color: '#000000',
      alpha: 0.12,
    })
    // The central play "well": a darkened oval with a faint gold ring marks the trick area.
    g.ellipse(WIDTH / 2, HEIGHT / 2, 237, 166).fill({ color: '#000000', alpha: 0.22 })
    g.ellipse(WIDTH / 2, HEIGHT / 2, 237, 166).stroke({ color: COLORS.wellRing, width: 2 })
    this.bgLayer.addChild(g)
  }

  // --- Seats (render.py _draw_seats) ---

  private reconcileSeats(scene: HeartsScene): void {
    clear(this.seatLayer)
    for (const seat of scene.seats) {
      this.seatLayer.addChild(this.makeSeat(seat))
    }
  }

  private makeSeat(seat: SceneSeat): Container {
    const c = new Container()
    c.position.set(seat.x, seat.y)
    const w = 158
    const h = 56
    const left = -w / 2
    const top = -h / 2

    // The active seat carries a gold halo whose alpha the per-frame loop breathes; it is named so
    // pulseActiveSeat can find it. Drawn first so it sits behind the badge body.
    if (seat.isTurn) {
      const halo = new Graphics()
      halo.label = 'halo'
      halo.roundRect(left - 7, top - 7, w + 14, h + 14, 16).fill({ color: COLORS.gold, alpha: 0.6 })
      c.addChild(halo)
    }

    const g = new Graphics()
    g.roundRect(left + 1, top + 3, w, h, 11).fill(COLORS.badgeShadow)
    g.roundRect(left, top, w, h, 11).fill(seat.isYou ? COLORS.badgeBgYou : COLORS.badgeBg)
    g.roundRect(left, top, w, h, 11).stroke({
      color: seat.isTurn ? COLORS.gold : COLORS.white,
      width: 2,
    })
    c.addChild(g)

    const label = this.text(seat.label, 22, COLORS.white, 'center')
    label.position.set(0, -11)
    c.addChild(label)
    const score = this.text(
      `${seat.score} pts`,
      18,
      seat.isTurn ? COLORS.gold : COLORS.dim,
      'center',
    )
    score.position.set(0, 13)
    c.addChild(score)
    return c
  }

  /** Breathe the active seat's glow (the only ambient animation), found by its 'halo' label. */
  private pulseActiveSeat(): void {
    const pulse = 0.5 + 0.5 * Math.sin((this.pulseMs / PULSE_PERIOD_MS) * Math.PI * 2)
    for (const seatNode of this.seatLayer.children) {
      const halo = (seatNode as Container).getChildByLabel?.('halo')
      if (halo) {
        halo.alpha = 0.35 + 0.4 * pulse
      }
    }
  }

  // --- Opponents (render.py _draw_opponents / _draw_opponent_row) ---

  private reconcileOpponents(opponents: readonly SceneCard[]): void {
    clear(this.opponentLayer)
    for (const card of opponents) {
      const node = card.faceUp
        ? this.makeCardFace(card.card, card.w, card.h, {})
        : this.makeCardBack(card.w, card.h)
      node.position.set(card.x, card.y)
      this.opponentLayer.addChild(node)
    }
  }

  // --- Center trick (render.py _draw_trick) ---

  private reconcileTrick(trick: readonly SceneTrickCard[]): void {
    clear(this.trickLayer)
    for (const card of trick) {
      const node = this.makeCardFace(card.card, SMALL_W, SMALL_H, {
        border: card.isWinner ? COLORS.winnerGlow : undefined,
        borderW: 4,
      })
      // Trick cards position by their center (render.py centers the rect on the offset point).
      node.position.set(card.x - SMALL_W / 2, card.y - SMALL_H / 2)
      this.trickLayer.addChild(node)
    }
  }

  /**
   * Draw a card fly-in at progress `t`: the cards already in the center sit static, and the played card
   * slides from where it left the player's hand (held and ringed gold during the hold) into its trick
   * spot, shrinking from hand size to trick size (mirrors render.py `_animate_card_played`).
   */
  private renderPlay(move: PlayMove, t: number): void {
    clear(this.trickLayer)
    clear(this.flyLayer)
    clear(this.pointsLayer)
    for (const card of move.resting) {
      const node = this.makeCardFace(card.card, SMALL_W, SMALL_H, {})
      node.position.set(card.x - SMALL_W / 2, card.y - SMALL_H / 2)
      this.trickLayer.addChild(node)
    }
    const { x, y, scale } = playCardAt(move, t)
    const w = move.fromW * scale
    const h = move.fromH * scale
    const node = this.makeCardFace(move.card, w, h, {
      // Held at the source it wears a gold "selected" ring (distinct from the green legal border); once
      // it starts sliding the ring drops, so it reads as "this is the card going out".
      border: t < PLAY_HOLD ? COLORS.gold : undefined,
      borderW: 4,
    })
    node.position.set(x - w / 2, y - h / 2)
    // The airborne card lives above the hand (flyLayer) so it lifts cleanly off the fan without its
    // neighbours occluding it; the resting center cards stay in trickLayer below.
    this.flyLayer.addChild(node)
  }

  /** Draw the four swept cards at progress `t`, plus the gold points pill (render.py _animate_trick_won). */
  private renderSweep(sweep: TrickSweep, t: number): void {
    clear(this.trickLayer)
    for (const card of sweep.cards) {
      const { x, y, scale } = sweepCardAt(card, sweep, t)
      const w = SMALL_W * scale
      const h = SMALL_H * scale
      const isWinner = card.seat === sweep.winner
      const node = this.makeCardFace(card.card, w, h, {
        border: isWinner ? COLORS.winnerGlow : undefined,
        borderW: 4,
      })
      node.position.set(x - w / 2, y - h / 2)
      this.trickLayer.addChild(node)
    }
    this.renderPointsPill(sweep, t)
  }

  /** The gold "+N" pill above the winner's seat, scaling in during the hold (render.py _draw_points_pill). */
  private renderPointsPill(sweep: TrickSweep, t: number): void {
    clear(this.pointsLayer)
    if (sweep.points <= 0) {
      return
    }
    // smoothstep clamps, so past the hold (t/SWEEP_HOLD >= 1) this naturally pins to 1.
    const appear = smoothstep(t / SWEEP_HOLD)
    const c = new Container()
    c.position.set(sweep.toX, sweep.toY - 56)
    c.scale.set(0.6 + 0.4 * appear)
    const label = this.text(`+${sweep.points}`, 30, '#201812', 'center')
    const padX = 16
    const pillW = label.width + padX * 2
    const pillH = 36
    const g = new Graphics()
    g.roundRect(-pillW / 2, -pillH / 2, pillW, pillH, pillH / 2).fill(COLORS.gold)
    g.roundRect(-pillW / 2, -pillH / 2, pillW, pillH, pillH / 2).stroke({
      color: '#fff4ce',
      width: 2,
    })
    c.addChild(g)
    label.position.set(0, 0)
    c.addChild(label)
    this.pointsLayer.addChild(c)
  }

  // --- The view seat's hand (render.py _draw_hand), with click-to-play wiring ---

  private reconcileHand(hand: readonly SceneHandCard[], viewSeat: number): void {
    clear(this.handLayer)
    const slot = `player_${viewSeat}`
    for (const card of hand) {
      this.handLayer.addChild(this.makeHandCard(card, slot))
    }
  }

  private makeHandCard(card: SceneHandCard, slot: string): Container {
    const node = this.makeCardFace(card.card, card.w, card.h, {
      border: card.legal ? COLORS.legalBorder : undefined,
      borderW: 4,
      greyed: !card.legal,
    })
    node.position.set(card.x, card.y)
    // Spectators and replays have no sendAction, so the cards stay inert and draw-only — no hover, no
    // clicks. In live play the hand is interactive: every card highlights on hover (so the user sees
    // which card is under the cursor), and a legal card on the controlled seat's turn is clickable.
    const sendAction = this.ctx.sendAction
    if (sendAction !== undefined) {
      node.eventMode = 'static'
      // An explicit rectangular hit area so the whole card face hit-tests (a Container otherwise only
      // hit-tests interactive children, and the drawn Graphics are passive).
      node.hitArea = new Rectangle(0, 0, card.w, card.h)

      // Hover feedback: lift the card and ring it gold while the cursor is over it. Transient view
      // chrome, mutated on the node directly (it is rebuilt each state, so no stale hover leaks).
      const hoverRing = this.makeHoverRing(card.w, card.h)
      node.addChild(hoverRing)
      let hovered = false
      node.on('pointerover', () => {
        if (hovered) {
          return
        }
        hovered = true
        hoverRing.visible = true
        node.position.set(card.x, card.y - HOVER_LIFT)
      })
      node.on('pointerout', () => {
        hovered = false
        hoverRing.visible = false
        node.position.set(card.x, card.y)
      })

      if (card.controllable) {
        node.cursor = 'pointer'
        node.on('pointertap', () => sendAction(slot, card.card))
      }
    }
    return node
  }

  /** A hidden gold outline added to a hand card, shown on hover (see {@link makeHandCard}). */
  private makeHoverRing(w: number, h: number): Graphics {
    const radius = Math.max(3, w * 0.11)
    const g = new Graphics()
    g.roundRect(0, 0, w, h, radius).stroke({ color: COLORS.gold, width: 4 })
    g.visible = false
    return g
  }

  // --- Status strip (render.py _draw_status) ---

  private reconcileStatus(scene: HeartsScene): void {
    clear(this.statusLayer)
    // Tall enough to hold both rows; kept in lockstep with render.py `strip_h`. (A brief stint at 55
    // clipped the hint row and diverged from the Python twin, so it is back to 60.)
    const stripH = 60
    const panel = new Graphics()
    panel.rect(0, 0, WIDTH, stripH).fill({ color: '#000000', alpha: 0.41 })
    panel.moveTo(0, stripH).lineTo(WIDTH, stripH).stroke({ color: COLORS.goldDim, width: 1 })
    this.statusLayer.addChild(panel)

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
      // Sit just under the first row; the small +2 gap keeps the hint inside the 60px panel (render.py twin).
      hint.position.set(16, 9 + trick.height + 2)
      this.statusLayer.addChild(hint)
    }
    // The end-of-match leaderboard is host chrome now (GameOverCard.vue / scripts/play.py), not drawn
    // into the canvas; the strip's "Game over" message (s.message) is the renderer's only terminal note.
  }

  // --- Move clock (the active human's per-move budget chip; hidden in replay/spectate) ---

  private reconcileClock(scene: HeartsScene): void {
    clear(this.clockLayer)
    const clock = scene.moveClock
    if (clock === null) {
      return
    }
    const c = new Container()
    c.position.set(clock.x, clock.y)
    const label = this.text(`⏱ ${clock.seconds}s`, 20, COLORS.gold, 'center')
    const padX = 14
    const w = label.width + padX * 2
    const h = 32
    const g = new Graphics()
    g.roundRect(-w / 2, -h / 2, w, h, h / 2).fill({ color: '#0f3a27', alpha: 0.92 })
    g.roundRect(-w / 2, -h / 2, w, h, h / 2).stroke({ color: COLORS.gold, width: 2 })
    c.addChild(g)
    label.position.set(0, 0)
    c.addChild(label)
    this.clockLayer.addChild(c)
  }

  // --- Card primitives (render.py _draw_card_face / _draw_card_back / _draw_suit_shapes) ---

  /**
   * Build a face-up card as a Container at (0,0): a rounded cream face, an optional colored border (legal
   * green, winner gold), the corner rank index with a small suit pip, the big center suit pip, the
   * mirrored bottom-right rank, and an optional grey veil for an illegal card.
   */
  private makeCardFace(
    card: number,
    w: number,
    h: number,
    opts: { border?: string; borderW?: number; greyed?: boolean },
  ): Container {
    const c = new Container()
    const radius = Math.max(3, w * 0.11)
    const g = new Graphics()
    // Soft drop shadow for lift, then the face and its thin edge.
    g.roundRect(2, 3, w, h, radius).fill({ color: '#000000', alpha: 0.3 })
    g.roundRect(0, 0, w, h, radius).fill(COLORS.cardFace)
    g.roundRect(0, 0, w, h, radius).stroke({ color: COLORS.cardEdge, width: 1 })
    if (opts.border !== undefined) {
      g.roundRect(0, 0, w, h, radius).stroke({ color: opts.border, width: opts.borderW ?? 3 })
    }
    c.addChild(g)

    const suit = suitOf(card)
    const ink = suit === DIAMONDS || suit === HEARTS ? COLORS.redInk : COLORS.blackInk
    const rankStr = RANK_LABELS[rankOf(card)] ?? '?'

    // Corner index: rank in the top-left with a small pip beneath it (render.py _draw_corner_index).
    const rankSize = Math.max(12, h * 0.22)
    const rank = this.text(rankStr, rankSize, ink, 'left')
    rank.position.set(w * 0.08, h * 0.03)
    c.addChild(rank)
    const pips = new Graphics()
    const cornerPip = Math.max(6, w * 0.17)
    this.drawSuit(
      pips,
      suit,
      w * 0.08 + cornerPip * 0.4,
      h * 0.03 + rank.height + cornerPip * 0.5,
      cornerPip,
      ink,
    )
    // Center pip: the big suit mark (render.py centers a size = rect.width * 0.5 pip).
    this.drawSuit(pips, suit, w / 2, h / 2, w * 0.5, ink)
    c.addChild(pips)

    // Mirror the rank bottom-right, rotated 180, for a real-card read.
    const rank2 = this.text(rankStr, rankSize, ink, 'left')
    rank2.anchor.set(0, 0)
    rank2.rotation = Math.PI
    rank2.position.set(w - w * 0.08, h - h * 0.03)
    c.addChild(rank2)

    if (opts.greyed) {
      const veil = new Graphics()
      veil
        .roundRect(0, 0, w, h, radius)
        .fill({ color: COLORS.greyVeil, alpha: COLORS.greyVeilAlpha })
      c.addChild(veil)
    }
    return c
  }

  /** A face-down card: a gold lattice on deep blue with a gold rim (render.py _draw_card_back). */
  private makeCardBack(w: number, h: number): Container {
    const c = new Container()
    const radius = Math.max(3, w * 0.1)
    const g = new Graphics()
    g.roundRect(2, 3, w, h, radius).fill({ color: '#000000', alpha: 0.3 })
    g.roundRect(0, 0, w, h, radius).fill(COLORS.cardBack)
    const inset = 5
    g.roundRect(inset, inset, w - inset * 2, h - inset * 2, radius * 0.6).fill(COLORS.cardBackDark)
    c.addChild(g)
    // Diagonal gold lattice clipped to the inner panel.
    const lattice = new Graphics()
    const spacing = 11
    for (let x = -h; x < w + h; x += spacing) {
      lattice
        .moveTo(x, 0)
        .lineTo(x + h, h)
        .stroke({ color: COLORS.cardBackGold, width: 1, alpha: 0.7 })
      lattice
        .moveTo(x, h)
        .lineTo(x + h, 0)
        .stroke({ color: COLORS.cardBackGold, width: 1, alpha: 0.7 })
    }
    const mask = new Graphics()
    mask.roundRect(inset, inset, w - inset * 2, h - inset * 2, radius * 0.6).fill('#ffffff')
    lattice.mask = mask
    c.addChild(mask)
    c.addChild(lattice)
    g.roundRect(0, 0, w, h, radius).stroke({ color: COLORS.cardBackGold, width: 2 })
    return c
  }

  /**
   * Draw an antialiased suit pip centered at (cx, cy) within a `size`-pixel box, from primitives rather
   * than a font glyph (the suits are not in the UI font). A faithful port of render.py
   * `_draw_suit_shapes`: PixiJS Graphics are vector and antialiased, so no supersampling is needed.
   */
  private drawSuit(
    g: Graphics,
    suit: number,
    cx: number,
    cy: number,
    size: number,
    ink: string,
  ): void {
    const half = size / 2
    if (suit === DIAMONDS) {
      const hw = size * 0.36
      const hh = size * 0.5
      g.poly([cx, cy - hh, cx + hw, cy, cx, cy + hh, cx - hw, cy]).fill(ink)
      return
    }
    if (suit === HEARTS) {
      const r = size * 0.25
      const lobeY = cy - size * 0.1
      g.circle(cx - r, lobeY, r).fill(ink)
      g.circle(cx + r, lobeY, r).fill(ink)
      g.poly([cx - 2 * r, lobeY, cx + 2 * r, lobeY, cx, cy + half]).fill(ink)
      return
    }
    if (suit === SPADES) {
      const r = size * 0.25
      const lobeY = cy + size * 0.1
      g.circle(cx - r, lobeY, r).fill(ink)
      g.circle(cx + r, lobeY, r).fill(ink)
      g.poly([cx - 2 * r, lobeY, cx + 2 * r, lobeY, cx, cy - half]).fill(ink)
      this.drawSuitStem(g, cx, cy, size, ink)
      return
    }
    // Clubs: a trefoil of three circles plus a stem.
    const r = size * 0.22
    g.circle(cx, cy - size * 0.16, r).fill(ink)
    g.circle(cx - size * 0.22, cy + size * 0.1, r).fill(ink)
    g.circle(cx + size * 0.22, cy + size * 0.1, r).fill(ink)
    this.drawSuitStem(g, cx, cy, size, ink)
  }

  /** The little trapezoid stem shared by the spade and club pips (render.py _draw_suit_stem). */
  private drawSuitStem(g: Graphics, cx: number, cy: number, size: number, ink: string): void {
    g.poly([
      cx - size * 0.16,
      cy + size * 0.48,
      cx + size * 0.16,
      cy + size * 0.48,
      cx + size * 0.06,
      cy + size * 0.1,
      cx - size * 0.06,
      cy + size * 0.1,
    ]).fill(ink)
  }

  /**
   * A Text node baked at the right device resolution. `left`/`right` anchor at the top edge (the status
   * strip positions from the top), while `center` anchors at the middle (badges, pills, the move clock
   * position from their center point).
   */
  private text(
    value: string,
    size: number,
    fill: string,
    align: 'left' | 'center' | 'right',
  ): Text {
    const node = new Text({
      text: value,
      style: { fontFamily: 'system-ui, sans-serif', fontWeight: 'bold', fontSize: size, fill },
    })
    node.resolution = this.textResolution()
    if (align === 'center') {
      node.anchor.set(0.5, 0.5)
    } else {
      node.anchor.set(align === 'left' ? 0 : 1, 0)
    }
    return node
  }
}

/** Remove and destroy every child of a layer (its scene graph and any baked text textures). */
function clear(layer: Container): void {
  for (const child of layer.removeChildren()) {
    child.destroy({ children: true })
  }
}

/**
 * How long the sweep should run. Live play (no budget) uses the natural length; a replay passes its
 * cadence as the budget, and we fit the sweep inside ~85% of it so it finishes before the next state.
 */
function sweepDuration(options?: RenderOptions): number {
  if (options?.transitionMs && options.transitionMs > 0) {
    return Math.max(SWEEP_MIN_MS, Math.min(SWEEP_NATURAL_MS, options.transitionMs * 0.85))
  }
  return SWEEP_NATURAL_MS
}

/**
 * How long the fly-in runs, and the sweep that may chain after it on the fourth card. Live play (no
 * budget) gives each phase its natural length. A replay passes its cadence as the budget: the fly-in
 * takes ~45% of it (so the card rests in the center for most of the step) and the chained sweep ~50%
 * (`sweepMs` is 0 when no sweep chains). The two are then scaled down together if they would still
 * overflow the budget, so a chained fly-in + sweep always finish inside one cadence — the next snapshot
 * never cuts the sweep short — while keeping their relative pacing.
 */
function playPhaseDurations(
  options: RenderOptions | undefined,
  chained: boolean,
): { playMs: number; sweepMs: number } {
  if (!options?.transitionMs || options.transitionMs <= 0) {
    return { playMs: PLAY_NATURAL_MS, sweepMs: chained ? SWEEP_NATURAL_MS : 0 }
  }
  const budget = options.transitionMs
  let playMs = Math.max(PLAY_MIN_MS, Math.min(PLAY_NATURAL_MS, budget * 0.45))
  let sweepMs = chained ? Math.max(SWEEP_MIN_MS, Math.min(SWEEP_NATURAL_MS, budget * 0.5)) : 0
  const cap = budget * 0.95
  if (playMs + sweepMs > cap) {
    const scale = cap / (playMs + sweepMs)
    playMs *= scale
    sweepMs *= scale
  }
  return { playMs, sweepMs }
}
