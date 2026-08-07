/**
 * The shared retained (PixiJS) layer for a trick-taking card renderer: a {@link PixiRenderer} subclass
 * that reconciles the persistent scene graph toward a {@link CardTableScene} and animates the two
 * transitions that carry real game meaning — the card-play fly-in and the trick-won sweep — off the base
 * class's per-frame ticker. Every four-player card game (Hearts, Spades) draws the felt, player badges,
 * trick, fanned hand, opponent rows, and card faces identically, so all of that lives here; a game
 * subclass supplies only its overlay→scene function, its geometry, its per-player badge interior, its
 * status strip, and any center extras (Spades' bid chips).
 *
 * This is the canonical retained browser renderer for the shared card table. Game-specific subclasses
 * supply their semantic-overlay scene, player content, status, and center controls.
 *
 * It keeps the pure/retained split the architecture rests on: a game's `computeScene` (in its own
 * scene.ts) is a pure function of state that produces the static "snapped" table a scrubber lands on, and
 * this class reconciles toward it. Because the animation is driven by a wall-clock budget the host
 * supplies (the replay cadence, a live default, or zero to snap), it replays at replay-time scale rather
 * than breaking the scrubber.
 */
import type { StepState } from '@game-sandbox/schema'
import { Container, FillGradient, Graphics, Rectangle } from 'pixi.js'

import { MoveClock } from '../base/move-clock.js'
import { clear, PixiRenderer } from '../base/PixiRenderer.js'
import { type RendererContext, type RenderOptions, transitionScaleOf } from '../types.js'
import {
  type Card,
  type CardTableScene,
  COLORS,
  cardKey,
  cardToAction,
  DIAMONDS,
  detectPlay,
  detectSweep,
  HEARTS,
  HEIGHT,
  PLAY_HOLD,
  type PlayMove,
  playCardAt,
  rankLabel,
  type SceneCard,
  type SceneConfig,
  type SceneHandCard,
  type SceneTrickCard,
  SMALL_H,
  SMALL_W,
  SPADES,
  SWEEP_HOLD,
  smoothstep,
  sweepCardAt,
  type TableGeometry,
  type TrickSweep,
  WIDE_SEAT_TINTS,
  WIDTH,
  wideSeatsAccessibilityLabel,
} from './scene.js'

/** The natural trick-won sweep length (ms); the host's scale speeds it up or slows it down. */
const SWEEP_NATURAL_MS = 700
/** The natural card-play fly-in length (ms); the host's scale speeds it up or slows it down. */
const PLAY_NATURAL_MS = 480
/** The active-player glow's breathing period (ms): a gentle pulse, the only ambient animation. */
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

/** A trick-won sweep phase: the four cards sliding into the winner, with the game's winner pill. */
interface SweepPhase {
  kind: 'sweep'
  sweep: TrickSweep
  /** The pill text the game raises over the winner during the sweep (Hearts "+N", Spades "won/bid"). */
  pillText: string | null
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

/**
 * The shared card-table renderer. `TScene` is the game's scene shape (which extends
 * {@link CardTableScene}); a subclass implements the abstract hooks and may override the optional ones.
 */
export abstract class CardTableRenderer<
  TScene extends CardTableScene = CardTableScene,
> extends PixiRenderer {
  // 960x720 is the pinned table size (see scene.ts), a 4:3 landscape, so the host places the decision
  // log below the canvas rather than beside it.
  readonly internalSize = { width: WIDTH, height: HEIGHT } as const
  // This renderer animates the trick sweep and an ambient player-glow pulse off the base's ticker.
  protected override readonly animated = true

  /** Persistent layers, painted back-to-front. Built once in {@link setup}. */
  protected bgLayer!: Container
  protected playerLayer!: Container
  protected opponentLayer!: Container
  protected trickLayer!: Container
  /** Center extras a game draws (Spades' bid chips); empty and unused by Hearts. */
  protected gameLayer!: Container
  protected handLayer!: Container
  protected flyLayer!: Container
  protected statusLayer!: Container
  protected clockLayer!: Container
  /** The winner pill raised during a sweep (Hearts' points, Spades' won/bid). */
  protected pillLayer!: Container

  /** The scene the static layers were last reconciled to, reused by the per-frame loop. */
  protected scene: TScene | null = null
  /** The previously rendered state, so `detectSweep`/`detectPlay` can spot a transition. */
  private lastState: StepState | null = null
  /** The running center transition (a play fly-in and/or trick sweep), or null when drawn statically. */
  private active: ActiveTransition | null = null
  /** Accumulated wall-clock time driving the ambient active-player pulse. */
  private pulseMs = 0
  /** The countdown behind the chip. The scene carries the budget; elapsed time cannot live in a frame. */
  private readonly moveClock = new MoveClock()
  /** Cached gradient for the felt backdrop (one GPU texture, freed in destroy). */
  private feltGradient: FillGradient | null = null
  /** The accessibility label this renderer owns when the table has wide seats. */
  private readonly wideSeatsLabel: string | null

  constructor(ctx: RendererContext) {
    super(ctx)
    this.wideSeatsLabel = wideSeatsAccessibilityLabel(ctx.meta.display_name, ctx.header.seats)
    if (this.wideSeatsLabel !== null) {
      ctx.container.setAttribute('role', 'img')
      ctx.container.setAttribute('aria-label', this.wideSeatsLabel)
    }
  }

  // --- Subclass hooks ---

  /** The table geometry this game draws at. */
  protected abstract readonly geometry: TableGeometry

  /** Turn one recorded state into this game's scene. */
  protected abstract computeSceneFor(state: StepState): TScene

  /** Draw the player badge interior. The frame, halo, and border come from {@link makePlayer}. */
  protected abstract drawPlayerContent(
    container: Container,
    player: TScene['players'][number],
  ): void

  /** Draw the top status strip. The layer is cleared first; use {@link makeStatusPanel}. */
  protected abstract reconcileStatus(scene: TScene): void

  /** The pill text raised over the winner during a sweep, or null for none. */
  protected sweepPillText(_sweep: TrickSweep, _state: StepState): string | null {
    return null
  }

  /** Draw center extras into {@link gameLayer}, such as Spades bid chips. */
  protected reconcileGameLayers(_scene: TScene): void {}

  /** A seam run at the end of each {@link update}, before the previous state is replaced, for a game's
   *  own state-to-state effects (Spades' bid-badge pulse). Default: nothing. */
  protected afterUpdate(
    _prev: StepState | null,
    _state: StepState,
    _options?: RenderOptions,
  ): void {}

  /** A per-frame seam OR'd into the animation loop's "keep going?" result, for a game's own ambient or
   *  transition animation (Spades' bid pulse). Default: no extra work. */
  protected onFrameExtra(_dtMs: number): boolean {
    return false
  }

  /**
   * The fly-in and the sweep are the table's transition; the candle glow under the active seat is
   * ambient and runs for the whole hand, so it is deliberately not counted here. A game with its own
   * state-to-state flourish (Spades' bid effects) ORs it in.
   */
  protected override transitionActive(): boolean {
    return this.active !== null
  }

  /** The mount-time scene config, assembled from the renderer context; a game's `computeSceneFor` uses it. */
  protected sceneConfig(): SceneConfig {
    return {
      controlledPlayers: this.ctx.controlledPlayers,
      humanTimeoutMs: this.ctx.meta.human_timeout_ms,
      seats: this.ctx.header.seats,
    }
  }

  // --- Setup / teardown ---

  protected setup(root: Container): void {
    this.bgLayer = new Container()
    this.playerLayer = new Container()
    this.opponentLayer = new Container()
    this.trickLayer = new Container()
    this.gameLayer = new Container()
    this.handLayer = new Container()
    this.flyLayer = new Container()
    this.statusLayer = new Container()
    this.clockLayer = new Container()
    this.pillLayer = new Container()
    for (const layer of [
      this.bgLayer,
      this.playerLayer,
      this.opponentLayer,
      this.trickLayer,
      // Center extras (bid chips) sit above the trick but below the hand and the fly-in's airborne card.
      this.gameLayer,
      this.handLayer,
      // The fly-in's airborne card sits above the hand so it lifts cleanly off the fan (the static
      // trick and resting cards stay in trickLayer below).
      this.flyLayer,
      this.statusLayer,
      this.clockLayer,
      this.pillLayer,
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
    if (
      this.wideSeatsLabel !== null &&
      this.ctx.container.getAttribute('aria-label') === this.wideSeatsLabel
    ) {
      this.ctx.container.removeAttribute('aria-label')
      this.ctx.container.removeAttribute('role')
    }
  }

  // --- The per-state reconcile and per-frame animation loop ---

  protected update(state: StepState, options?: RenderOptions): void {
    const prev = this.lastState
    const scene = this.computeSceneFor(state)
    this.scene = scene

    // A scrub or seek snaps, and so does a zero scale, so neither animates; otherwise a newly-played
    // card kicks off a fly-in and a newly-completed trick kicks off the sweep.
    const snap = options?.snap === true || transitionScaleOf(options) === 0
    const play = snap ? null : detectPlay(prev, state, scene.viewPlayer, this.geometry)
    const sweep = snap ? null : detectSweep(prev, state, scene.viewPlayer, this.geometry)

    // Static layers: rebuilt wholesale each state. Players, status, clock, and game extras always reflect
    // the new state; the hand and opponent rows are held at the previous layout during a fly-in (below).
    // The base clears the status and game layers so a subclass hook only adds its own children.
    this.reconcilePlayers(scene)
    clear(this.statusLayer)
    this.reconcileStatus(scene)
    // Every state is one completed transition, so the tick names the move now on the clock. Redrawing
    // the same state (a resize, an asset arriving) reopens the same turn and leaves the countdown alone.
    if (scene.moveClock === null) this.moveClock.close()
    else this.moveClock.open(String(state.tick), scene.moveClock.totalMs)
    this.reconcileClock(scene)
    clear(this.gameLayer)
    this.reconcileGameLayers(scene)

    if (play !== null && prev !== null) {
      // Hold the source hand/row at its previous layout for the fly-in, so the other cards don't
      // re-fan to close the gap while one card flies out: the played card's position stays a placeholder
      // (the flyer fills it during the hold, then leaves it empty as it slides). The held cards are
      // made inert; the hand re-fans to the new, smaller layout once the fly-in lands (see onFrame).
      const before = this.computeSceneFor(prev)
      // Match the played card by stable key: Card objects are re-parsed fresh each frame, so a
      // reference compare (c.card !== play.card) would never exclude it and the flyer would double it.
      const playedKey = cardKey(play.card)
      this.reconcileHand(
        before.hand
          .filter((c) => cardKey(c.card) !== playedKey)
          .map((c) => ({ ...c, controllable: false })),
        scene.viewPlayer,
      )
      this.reconcileOpponents(
        before.opponents
          .filter((c) => cardKey(c.card) !== playedKey)
          .map((c) => ({ ...c, controllable: false })),
      )
      // The fourth card resolves the trick in the same step, so its fly-in chains into the sweep;
      // cards 1–3 have no sweep to chain to. Both phases keep their natural length at the host's
      // scale, and the chained pair simply runs longer (see playPhaseDurations).
      const chained = play.completesTrick && sweep !== null
      const { playMs, sweepMs } = playPhaseDurations(options, chained)
      this.active = {
        phase: { kind: 'play', move: play, elapsedMs: 0, durationMs: playMs },
        nextSweep: chained
          ? {
              kind: 'sweep',
              sweep,
              pillText: this.sweepPillText(sweep, state),
              elapsedMs: 0,
              durationMs: sweepMs,
            }
          : null,
      }
      this.renderPlay(play, 0)
    } else {
      // No fly-in this state: settle the hand/opponents and clear any airborne card from a fly-in that
      // an immediate snap/seek interrupted.
      clear(this.flyLayer)
      this.reconcileHand(scene.hand, scene.viewPlayer)
      this.reconcileOpponents(scene.opponents)
      if (sweep !== null) {
        const phase: SweepPhase = {
          kind: 'sweep',
          sweep,
          pillText: this.sweepPillText(sweep, state),
          elapsedMs: 0,
          durationMs: sweepDuration(options),
        }
        this.active = { phase, nextSweep: null }
        this.renderSweep(phase, 0)
      } else {
        this.active = null
        clear(this.pillLayer)
        this.reconcileTrick(scene.trick)
      }
    }

    this.afterUpdate(prev, state, options)
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
          this.reconcileHand(this.scene.hand, this.scene.viewPlayer)
          this.reconcileOpponents(this.scene.opponents)
          if (active.nextSweep !== null) {
            const next = active.nextSweep
            active.phase = next
            active.nextSweep = null
            this.renderSweep(next, 0)
          } else {
            this.active = null
            this.reconcileTrick(this.scene.trick)
          }
        } else {
          this.renderPlay(phase.move, t)
        }
      } else {
        // Drive the trick-won sweep: slide and shrink the cards into the winner, then leave the center
        // clear because the cards are with the winner now.
        if (t >= 1) {
          this.active = null
          clear(this.trickLayer)
          clear(this.pillLayer)
        } else {
          this.renderSweep(phase, t)
        }
      }
    }

    // Ambient: breathe the active player's glow. Pulsing keeps the loop alive until the hand ends.
    this.pulseActivePlayer()
    this.reconcileClock(this.scene)
    const extra = this.onFrameExtra(dtMs)
    return this.active !== null || extra || !this.scene.terminal
  }

  // --- Table backdrop, built once ---

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

  // --- Players ---

  private reconcilePlayers(scene: TScene): void {
    clear(this.playerLayer)
    for (const player of scene.players) {
      this.playerLayer.addChild(this.makePlayer(player))
    }
  }

  /**
   * Build a player badge Container at the player's anchor: the ambient turn halo, the badge body and border,
   * and then the game's interior via {@link drawPlayerContent}. Named `player-N` so a game's per-player
   * animation (Spades' bid pulse) can find it.
   */
  private makePlayer(player: TScene['players'][number]): Container {
    const c = new Container()
    c.label = `player-${player.player}`
    c.position.set(player.x, player.y)
    const w = this.geometry.badgeW
    const h = this.geometry.badgeH
    const left = -w / 2
    const top = -h / 2

    // The active player carries a gold halo whose alpha the per-frame loop breathes; it is named so
    // pulseActivePlayer can find it. Drawn first so it sits behind the badge body.
    if (player.isTurn) {
      const halo = new Graphics()
      halo.label = 'halo'
      halo.roundRect(left - 7, top - 7, w + 14, h + 14, 16).fill({ color: COLORS.gold, alpha: 0.6 })
      c.addChild(halo)
    }

    const g = new Graphics()
    g.roundRect(left + 1, top + 3, w, h, 11).fill(COLORS.badgeShadow)
    g.roundRect(left, top, w, h, 11).fill(player.isYou ? COLORS.badgeBgYou : COLORS.badgeBg)
    g.roundRect(left, top, w, h, 11).stroke({
      color: player.isTurn ? COLORS.gold : COLORS.white,
      width: 2,
    })
    c.addChild(g)

    if (player.assignmentGroup !== null) {
      const tab = new Graphics()
      tab
        .roundRect(left + 5, top + 9, 4, h - 18, 2)
        .fill(WIDE_SEAT_TINTS[player.assignmentGroup % WIDE_SEAT_TINTS.length] ?? COLORS.white)
      c.addChild(tab)
    }

    this.drawPlayerContent(c, player)
    return c
  }

  /** Breathe the active player's glow (the only ambient animation), found by its 'halo' label. */
  private pulseActivePlayer(): void {
    const pulse = 0.5 + 0.5 * Math.sin((this.pulseMs / PULSE_PERIOD_MS) * Math.PI * 2)
    for (const playerNode of this.playerLayer.children) {
      const halo = (playerNode as Container).getChildByLabel?.('halo')
      if (halo) {
        halo.alpha = 0.35 + 0.4 * pulse
      }
    }
  }

  // --- Opponents ---

  private reconcileOpponents(opponents: readonly SceneCard[]): void {
    clear(this.opponentLayer)
    for (const card of opponents) {
      let node: Container
      if (!card.faceUp) {
        node = this.makeCardBack(card.w, card.h)
      } else if (card.controlled) {
        node = this.makeHandCard(card, `player_${card.player}`)
      } else {
        node = this.makeCardFace(card.card, card.w, card.h, {})
      }
      node.position.set(card.x, card.y)
      this.opponentLayer.addChild(node)
    }
  }

  // --- Center trick ---

  private reconcileTrick(trick: readonly SceneTrickCard[]): void {
    clear(this.trickLayer)
    for (const card of trick) {
      const node = this.makeCardFace(card.card, SMALL_W, SMALL_H, {
        border: card.isWinner ? COLORS.winnerGlow : undefined,
        borderW: 4,
      })
      // Trick cards position by their center.
      node.position.set(card.x - SMALL_W / 2, card.y - SMALL_H / 2)
      this.trickLayer.addChild(node)
    }
  }

  /**
   * Draw a card fly-in at progress `t`: the cards already in the center sit static, and the played card
   * slides from where it left the player's hand (held and ringed gold during the hold) into its trick
   * spot, shrinking from hand size to trick size.
   */
  private renderPlay(move: PlayMove, t: number): void {
    clear(this.trickLayer)
    clear(this.flyLayer)
    clear(this.pillLayer)
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

  /** Draw the four swept cards at progress `t`, plus the game's winner pill. */
  private renderSweep(phase: SweepPhase, t: number): void {
    clear(this.trickLayer)
    for (const card of phase.sweep.cards) {
      const { x, y, scale } = sweepCardAt(card, phase.sweep, t)
      const w = SMALL_W * scale
      const h = SMALL_H * scale
      const isWinner = card.player === phase.sweep.winner
      const node = this.makeCardFace(card.card, w, h, {
        border: isWinner ? COLORS.winnerGlow : undefined,
        borderW: 4,
      })
      node.position.set(x - w / 2, y - h / 2)
      this.trickLayer.addChild(node)
    }
    this.renderPill(phase.pillText, phase.sweep.toX, phase.sweep.toY - 56, t)
  }

  /**
   * The gold pill above the winner's player badge, scaling in during the hold. A
   * null text draws nothing (a trick that earned no flourish). Games supply the text via
   * {@link sweepPillText}.
   */
  private renderPill(text: string | null, x: number, y: number, t: number): void {
    clear(this.pillLayer)
    if (text === null) {
      return
    }
    // smoothstep clamps, so past the hold (t/SWEEP_HOLD >= 1) this naturally pins to 1.
    const appear = smoothstep(t / SWEEP_HOLD)
    const c = new Container()
    c.position.set(x, y)
    c.scale.set(0.6 + 0.4 * appear)
    const label = this.text(text, 30, '#201812', 'center')
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
    this.pillLayer.addChild(c)
  }

  // --- The view player's hand, with click-to-play wiring ---

  private reconcileHand(hand: readonly SceneHandCard[], viewPlayer: number): void {
    clear(this.handLayer)
    const playerId = `player_${viewPlayer}`
    for (const card of hand) {
      this.handLayer.addChild(this.makeHandCard(card, playerId))
    }
  }

  private makeHandCard(card: SceneHandCard, playerId: string): Container {
    const node = this.makeCardFace(card.card, card.w, card.h, {
      border: card.legal ? COLORS.legalBorder : undefined,
      borderW: 4,
      greyed: !card.legal,
    })
    node.position.set(card.x, card.y)
    // Spectators and replays have no sendAction, so the cards stay inert and draw-only — no hover, no
    // clicks. In live play the hand is interactive: every card highlights on hover (so the user sees
    // which card is under the cursor), and a legal card on the controlled player's turn is clickable.
    const sendAction = this.ctx.sendAction
    if (sendAction !== undefined) {
      node.eventMode = 'static'
      // An explicit rectangular hit area so the whole card face hit-tests (a Container otherwise only
      // hit-tests interactive children, and the drawn Graphics are passive).
      node.hitArea = new Rectangle(0, 0, card.w, card.h)

      // Hover feedback: lift the card and ring it gold while the cursor is over it. Transient view
      // chrome, mutated on the node directly (it is rebuilt each state, so no stale hover leaks).
      // The lift always runs toward the table centre, so it reads as raised from the bottom fan and
      // from a self-controlled partner's row along the top.
      const lift = card.y < HEIGHT / 2 ? HOVER_LIFT : -HOVER_LIFT
      const hoverRing = this.makeHoverRing(card.w, card.h)
      node.addChild(hoverRing)
      let hovered = false
      node.on('pointerover', () => {
        if (hovered) {
          return
        }
        hovered = true
        hoverRing.visible = true
        node.position.set(card.x, card.y + lift)
      })
      node.on('pointerout', () => {
        hovered = false
        hoverRing.visible = false
        node.position.set(card.x, card.y)
      })

      if (card.controllable) {
        node.cursor = 'pointer'
        node.on('pointertap', () => sendAction(playerId, cardToAction(card.card)))
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

  // --- Move clock (the active human's countdown chip; hidden in replay/spectate) ---

  private reconcileClock(scene: TScene): void {
    clear(this.clockLayer)
    const clock = scene.moveClock
    const reading = this.moveClock.read()
    if (clock === null || reading === null) {
      return
    }
    const c = new Container()
    c.position.set(clock.x, clock.y)
    const label = this.text(`⏱ ${reading.seconds}s`, 20, COLORS.gold, 'center')
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

  // --- Shared status helper (a game's reconcileStatus builds on this) ---

  /** The translucent status strip panel with its gold under-rule. */
  protected makeStatusPanel(stripH = 60): Graphics {
    const panel = new Graphics()
    panel.rect(0, 0, WIDTH, stripH).fill({ color: '#000000', alpha: 0.41 })
    panel.moveTo(0, stripH).lineTo(WIDTH, stripH).stroke({ color: COLORS.goldDim, width: 1 })
    return panel
  }

  // --- Card primitives ---

  /**
   * Build a face-up card as a Container at (0,0): a rounded cream face, an optional colored border (legal
   * green, winner gold), the corner rank index with a small suit pip, the big center suit pip, the
   * mirrored bottom-right rank, and an optional grey veil for an illegal card.
   */
  protected makeCardFace(
    card: Card,
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

    const suit = card.suit
    const ink = suit === DIAMONDS || suit === HEARTS ? COLORS.redInk : COLORS.blackInk
    const rankStr = rankLabel(card)

    // Corner index: rank in the top-left with a small pip beneath it.
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
    // Center pip: the big suit mark.
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

  /** A face-down card: a gold lattice on deep blue with a gold rim. */
  protected makeCardBack(w: number, h: number): Container {
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
   * than a font glyph because the suits are not in the UI font. PixiJS Graphics are vector and
   * antialiased, so no supersampling is needed.
   */
  protected drawSuit(
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

  /** The little trapezoid stem shared by the spade and club pips. */
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
}

/** How long the sweep runs: its natural length at whatever speed the host asked for. */
function sweepDuration(options?: RenderOptions): number {
  return SWEEP_NATURAL_MS * transitionScaleOf(options)
}

/**
 * How long the fly-in runs, and the sweep that may chain after it on the fourth card, each at its
 * natural length times the host's scale (`sweepMs` is 0 when no sweep chains). The two run back to
 * back, so a chained pair takes as long as both together and the host waits for the pair rather than
 * squeezing them into one cadence.
 */
function playPhaseDurations(
  options: RenderOptions | undefined,
  chained: boolean,
): { playMs: number; sweepMs: number } {
  const scale = transitionScaleOf(options)
  return { playMs: PLAY_NATURAL_MS * scale, sweepMs: chained ? SWEEP_NATURAL_MS * scale : 0 }
}
