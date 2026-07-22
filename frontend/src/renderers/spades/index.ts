/**
 * The Spades renderer: a {@link CardTableRenderer} subclass that supplies only what is Spades and not
 * generic trick-taking — the overlay→scene function, the seat badge's partnership tab and `bid / won`
 * line, the two-team status strip, the centre grid of clickable bid chips during the opening round, the
 * "won/bid" pill raised over a trick's winner, and the gold pulse plus chosen-chip flash that mark a
 * seat and its bid the instant a bid is placed.
 * The shared card table (felt, seats, trick, hand, opponents, card faces, and the fly-in/sweep
 * animation) lives in {@link CardTableRenderer}.
 *
 * The same class runs unchanged from a stored recording, where it has no `sendAction` and no controlled
 * slot, so the cards and chips are inert and it is draw-only (what the replay viewer relies on). It
 * registers under the metadata key `"spades"` (see `renderers/index.ts`).
 *
 * Spades-specific drawing stays here while the shared trick-taking table remains in the base class.
 */
import type { StepState } from '@game-sandbox/schema'
import { Container, Graphics, Rectangle } from 'pixi.js'

import { CardTableRenderer } from '../cards/CardTableRenderer.js'
import type { RenderOptions } from '../types.js'
import {
  asNumberList,
  CHIP_BG,
  CHIP_BG_HOVER,
  CHIP_EDGE,
  COLORS,
  computeScene,
  NIL_BID,
  NIL_INK,
  NUM_PLAYERS,
  type SceneBidChip,
  SPADES,
  SPADES_GEOMETRY,
  type SpadesScene,
  type SpadesSceneSeat,
  smoothstep,
  type TableGeometry,
  TEAM_TINT,
  type TrickSweep,
  WIDTH,
} from './scene.js'

/** The natural length (ms) of the gold pulse that marks a seat just after it bids. */
const BID_PULSE_NATURAL_MS = 620
/** The shortest that pulse is ever allowed to run, so a tiny replay budget still reads. */
const BID_PULSE_MIN_MS = 240
/** The muted spade-pip colour when spades are not yet broken. */
const SPADE_MUTED = '#5c7066'

/** A running gold pulse on the seat that just bid: a state-to-state flourish, not an ambient loop. */
interface BidPulse {
  seat: number
  elapsedMs: number
  durationMs: number
}

/** A running gold flash on the chosen chip in the centre grid, so the eye catches which bid was made. */
interface BidFlash {
  bid: number
  elapsedMs: number
  durationMs: number
}

export class SpadesRenderer extends CardTableRenderer<SpadesScene> {
  protected readonly geometry: TableGeometry = SPADES_GEOMETRY

  /** The gold pulse on the seat that just placed a bid, or null when no bid is being celebrated. */
  private bidPulse: BidPulse | null = null

  /** The gold flash on the chosen chip in the bid grid, or null when no bid is being celebrated. */
  private bidFlash: BidFlash | null = null

  protected computeSceneFor(state: StepState): SpadesScene {
    return computeScene(state, this.sceneConfig())
  }

  // Spades declares no base input intents: the shared hand wires on-screen card clicks per card and the
  // bid chips wire their own clicks below, so it inherits the base `inputs()` default of [].

  // --- Seat interior ---

  /** The badge interior: the partnership tab, the "(you)"-aware name, and the `bid · won` line. */
  protected drawSeatContent(container: Container, seat: SpadesSceneSeat): void {
    const w = this.geometry.badgeW
    const h = this.geometry.badgeH

    // A short partnership tab down the badge's left edge, so the two teams read at a glance.
    const tab = new Graphics()
    tab.roundRect(-w / 2 + 5, -h / 2 + 9, 4, h - 18, 2).fill(TEAM_TINT[seat.team] ?? COLORS.white)
    container.addChild(tab)

    const label = this.text(seat.label, 22, COLORS.white, 'center')
    label.position.set(0, -12)
    container.addChild(label)

    this.drawBidWon(container, seat)
  }

  /** The seat's `bid · won` line (a waiting note before a bid, NIL for nil) centred at badge y+14. */
  private drawBidWon(container: Container, seat: SpadesSceneSeat): void {
    if (seat.bid < 0) {
      const waiting = this.text('waiting to bid', 16, COLORS.dim, 'center')
      waiting.position.set(0, 14)
      container.addChild(waiting)
      return
    }
    const bidStr = seat.isNil ? 'NIL' : String(seat.bid)
    const bidColor = seat.isNil ? NIL_INK : seat.isTurn ? COLORS.gold : COLORS.white
    // Two adjacent pieces (bid tinted, won dim), centred as one line. Left-anchored text tops out at
    // its position, so shift each up by half its height to sit on the y+14 centre line.
    const bidImg = this.text(`bid ${bidStr}`, 16, bidColor, 'left')
    const wonImg = this.text(`  ·  won ${seat.won}`, 16, COLORS.dim, 'left')
    const startX = -(bidImg.width + wonImg.width) / 2
    bidImg.position.set(startX, 14 - bidImg.height / 2)
    wonImg.position.set(startX + bidImg.width, 14 - wonImg.height / 2)
    container.addChild(bidImg)
    container.addChild(wonImg)
  }

  // --- Trick-won pill ---

  /** A compact `won/bid` pill (e.g. "3/4") over the trick winner during the sweep. `tricks_won` already
   *  counts the just-won trick, so it reads "now 3 of your bid 4"; a nil-breaker shows "1/0". */
  protected override sweepPillText(sweep: TrickSweep, state: StepState): string | null {
    const o = (state.overlay ?? {}) as Record<string, unknown>
    const won = asNumberList(o.tricks_won)[sweep.winner] ?? 0
    const bid = asNumberList(o.bids)[sweep.winner] ?? 0
    return `${won}/${bid}`
  }

  // --- Status strip ---

  protected reconcileStatus(scene: SpadesScene): void {
    // The base clears the status layer before calling this; we just build the two rows.
    this.statusLayer.addChild(this.makeStatusPanel(60))

    const s = scene.status
    const phase = this.text(s.phaseText, 22, COLORS.white, 'left')
    phase.position.set(16, 9)
    this.statusLayer.addChild(phase)

    // Spades-broken indicator: a small spade pip (gold when broken, muted otherwise) plus a label.
    const hx = 16 + phase.width + 26
    const hy = 9 + phase.height / 2
    const spade = new Graphics()
    this.drawSuit(spade, SPADES, hx, hy, 15, s.spadesBroken ? COLORS.gold : SPADE_MUTED)
    this.statusLayer.addChild(spade)
    const sb = this.text(
      s.spadesBroken ? 'spades broken' : 'spades intact',
      18,
      s.spadesBroken ? COLORS.white : COLORS.dim,
      'left',
    )
    sb.position.set(hx + 14, 11)
    this.statusLayer.addChild(sb)

    const msg = this.text(
      s.message,
      22,
      s.messageTone === 'gold' ? COLORS.gold : COLORS.white,
      'right',
    )
    msg.position.set(WIDTH - 16, 9)
    this.statusLayer.addChild(msg)

    // Second row: the two team scores, each tinted with its partnership colour.
    let x = 16
    const rowY = 9 + phase.height + 2
    for (const team of s.teamScores) {
      const img = this.text(
        `${team.label}: ${team.score}`,
        18,
        TEAM_TINT[team.team] ?? COLORS.white,
        'left',
      )
      img.position.set(x, rowY)
      this.statusLayer.addChild(img)
      x += img.width + 28
    }
  }

  // --- Centre bid chips ---

  /** Draw the bidding-round chip grid into the game layer, or nothing once play begins. */
  protected override reconcileGameLayers(scene: SpadesScene): void {
    // The base clears the game layer before this runs.
    const panel = scene.bidPanel
    if (panel === null) {
      return
    }
    const prompt = this.text(
      panel.prompt,
      22,
      panel.promptTone === 'gold' ? COLORS.gold : COLORS.white,
      'center',
    )
    prompt.position.set(panel.x, panel.y)
    this.gameLayer.addChild(prompt)

    // A controllable chip sends its bid for the controlled seat, which is the seat at the bottom view.
    const slot = `player_${scene.viewSeat}`
    for (const chip of panel.chips) {
      this.gameLayer.addChild(this.makeBidChip(chip, slot))
    }
  }

  /**
   * Build one bid chip Container at its rect: the felt body and edge, the bid label (NIL tinted), a grey
   * veil when the chip is not in the mask, and — for a controllable chip — the hover feedback and the
   * click that sends the bid. Inert chips (a replay, an off-turn seat) are draw-only.
   */
  private makeBidChip(chip: SceneBidChip, slot: string): Container {
    const c = new Container()
    c.position.set(chip.x, chip.y)
    const radius = 8

    const body = new Graphics()
    body.roundRect(0, 0, chip.w, chip.h, radius).fill(CHIP_BG)
    body.roundRect(0, 0, chip.w, chip.h, radius).stroke({ color: CHIP_EDGE, width: 1 })
    c.addChild(body)

    const isNil = chip.bid === NIL_BID
    const sendAction = this.ctx.sendAction
    if (chip.controllable && sendAction !== undefined) {
      // Hover feedback sits above the body and below the label: brighten the felt and ring it gold.
      const hover = new Graphics()
      hover.roundRect(0, 0, chip.w, chip.h, radius).fill(CHIP_BG_HOVER)
      hover.roundRect(0, 0, chip.w, chip.h, radius).stroke({ color: COLORS.gold, width: 2 })
      hover.visible = false
      c.addChild(hover)

      c.eventMode = 'static'
      c.hitArea = new Rectangle(0, 0, chip.w, chip.h)
      c.cursor = 'pointer'
      c.on('pointerover', () => {
        hover.visible = true
      })
      c.on('pointerout', () => {
        hover.visible = false
      })
      c.on('pointertap', () => sendAction(slot, chip.action))
    }

    const label = this.text(
      isNil ? 'NIL' : String(chip.bid),
      isNil ? 16 : 22,
      isNil ? NIL_INK : COLORS.white,
      'center',
    )
    label.position.set(chip.w / 2, chip.h / 2)
    c.addChild(label)

    if (!chip.enabled) {
      // The grey veil marks a chip outside the emitted mask (a partial mask, or an off-turn read).
      const veil = new Graphics()
      veil.roundRect(0, 0, chip.w, chip.h, radius).fill({
        color: COLORS.greyVeil,
        alpha: COLORS.greyVeilAlpha,
      })
      c.addChild(veil)
    }
    return c
  }

  // --- Bid pulse (a per-seat flourish the moment a bid is placed) ---

  /**
   * Celebrate a bid: a gold pulse on the seat that just moved from "not yet bid" to a bid, and a gold
   * flash on the chip it chose in the centre grid — so a watcher catches both who bid and what. Both are
   * skipped on a snap (a scrub/seek lands statically, so nothing animates).
   */
  protected override afterUpdate(
    prev: StepState | null,
    state: StepState,
    options?: RenderOptions,
  ): void {
    if (options?.snap === true) {
      this.bidPulse = null
      this.bidFlash = null
      this.flyLayer.getChildByLabel?.('bid-flash')?.destroy()
      return
    }
    const before =
      prev === null ? [] : asNumberList((prev.overlay as Record<string, unknown>)?.bids)
    const after = asNumberList((state.overlay as Record<string, unknown>)?.bids)
    for (let seat = 0; seat < NUM_PLAYERS; seat++) {
      if ((before[seat] ?? -1) < 0 && (after[seat] ?? -1) >= 0) {
        const dur = bidPulseDuration(options)
        this.bidPulse = { seat, elapsedMs: 0, durationMs: dur }
        this.bidFlash = { bid: after[seat] ?? 0, elapsedMs: 0, durationMs: dur }
        break
      }
    }
  }

  /** Drive both bid flourishes each frame (the seat pulse and the chosen-chip flash); alive if either is. */
  protected override onFrameExtra(dtMs: number): boolean {
    // Advance both independently — a bare `||` would short-circuit and starve the flash whenever the
    // pulse is still running.
    const pulsing = this.driveBidPulse(dtMs)
    const flashing = this.driveBidFlash(dtMs)
    return pulsing || flashing
  }

  /** Drive the bid pulse: a gold ring on the seat badge that expands and fades, then clears itself. */
  private driveBidPulse(dtMs: number): boolean {
    const pulse = this.bidPulse
    if (pulse === null) {
      return false
    }
    pulse.elapsedMs += dtMs
    const t = pulse.elapsedMs / pulse.durationMs
    // The seat layer is rebuilt each state, so find the current badge fresh and re-draw the ring on it;
    // a stale ring from a prior frame (or a prior badge) is dropped first so nothing accumulates.
    const seatNode = this.seatLayer.getChildByLabel?.(`seat-${pulse.seat}`) as Container | null
    if (seatNode) {
      seatNode.getChildByLabel?.('bid-pulse')?.destroy()
    }
    if (t >= 1) {
      this.bidPulse = null
      return false
    }
    if (seatNode) {
      seatNode.addChild(this.makeBidPulseRing(t))
    }
    return true
  }

  /**
   * Drive the chosen-chip flash: a gold ring on the bid grid's chip that pops out and fades. Drawn into
   * the fly layer (above the chips, and empty during bidding since card fly-ins only happen in play), a
   * single labelled child redrawn each frame so nothing accumulates. If the fourth/last bid has already
   * ended the bidding round (`bidPanel === null`), there is no chip to flash — the seat pulse carries it.
   */
  private driveBidFlash(dtMs: number): boolean {
    const flash = this.bidFlash
    if (flash === null) {
      return false
    }
    flash.elapsedMs += dtMs
    const t = flash.elapsedMs / flash.durationMs
    this.flyLayer.getChildByLabel?.('bid-flash')?.destroy()
    if (t >= 1) {
      this.bidFlash = null
      return false
    }
    const chip = this.scene?.bidPanel?.chips.find((c) => c.bid === flash.bid)
    if (chip) {
      this.flyLayer.addChild(this.makeBidFlash(chip, t))
    }
    return true
  }

  /** A gold ring around the chosen chip at flash progress `t`: it pops outward and fades to nothing. */
  private makeBidFlash(chip: SceneBidChip, t: number): Graphics {
    const grow = 2 + 8 * smoothstep(t)
    const g = new Graphics()
    g.label = 'bid-flash'
    g.roundRect(chip.x - grow, chip.y - grow, chip.w + 2 * grow, chip.h + 2 * grow, 8).stroke({
      color: COLORS.gold,
      width: 3,
      alpha: 0.85 * (1 - t),
    })
    return g
  }

  /** A gold ring around the badge at pulse progress `t`: it expands outward and fades to nothing. */
  private makeBidPulseRing(t: number): Graphics {
    const w = this.geometry.badgeW
    const h = this.geometry.badgeH
    const grow = 7 + 6 * t
    const g = new Graphics()
    g.label = 'bid-pulse'
    g.roundRect(-w / 2 - grow, -h / 2 - grow, w + 2 * grow, h + 2 * grow, 16).stroke({
      color: COLORS.gold,
      width: 3,
      alpha: 0.7 * (1 - t),
    })
    return g
  }
}

/**
 * How long the bid pulse runs: the natural length in live play (no budget), or a slice of the replay
 * cadence clamped so a long or tiny budget still reads.
 */
function bidPulseDuration(options?: RenderOptions): number {
  if (options?.transitionMs && options.transitionMs > 0) {
    return Math.max(BID_PULSE_MIN_MS, Math.min(BID_PULSE_NATURAL_MS, options.transitionMs * 0.85))
  }
  return BID_PULSE_NATURAL_MS
}
