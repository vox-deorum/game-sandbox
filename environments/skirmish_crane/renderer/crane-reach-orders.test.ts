/**
 * Composing an order on the board: what is offered, what a click does, what gets sent, and what the
 * automatic-strike preview says about it.
 */
import { Container, type FederatedPointerEvent } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'

import {
  activationPulseAlpha,
  clockArc,
  drawOrderMarks,
  previewPhase,
  REVERT_PULSE_MS,
  revertPulse,
  setResetButtonActive,
  wireOrderButtons,
} from './composition.js'
import { MONO, type TextFactory } from './draw.js'
import { walkFieldFor } from './legality.js'
import {
  beginOrder,
  clickTile,
  endpointOf,
  offeredTiles,
  orderAction,
  orderTurnOpen,
  resetOrder,
  strikePreview,
  undoStep,
} from './orders.js'
import { encodePath } from './paths.js'
import { CraneReachRenderer } from './index.js'
import type { CraneReachScene, HexTile, SceneUnit } from './scene.js'

function tile(
  q: number,
  r: number,
  terrain: HexTile['terrain'] = 'grass',
  feature: HexTile['feature'] = 'none',
): HexTile {
  return { key: `${q},${r}`, q, r, terrain, feature, center: { x: q, y: r }, corners: [] }
}

/** A small open field with the unit at the origin, wide enough for four cavalry steps. */
function openField(size = 6): HexTile[] {
  const tiles: HexTile[] = []
  for (let q = -size; q <= size; q += 1) {
    for (let r = -size; r <= size; r += 1) tiles.push(tile(q, r))
  }
  return tiles
}

function unitAt(
  unitId: string,
  tileKey: string,
  type: SceneUnit['type'] = 'footman',
  side: SceneUnit['side'] = 'red',
): SceneUnit {
  const [q, r] = tileKey.split(',').map(Number) as [number, number]
  return {
    playerId: unitId,
    unitId,
    side,
    type,
    hitPoints: 1,
    position: { x: q, y: r },
    tileKey,
  }
}

describe('Crane Reach order composition', () => {
  it('builds a path one step at a time and sends its stable path id', () => {
    const unit = unitAt('red_cavalry_0', '0,0', 'cavalry')
    const tiles = openField()
    const field = walkFieldFor(unit, tiles, [unit])

    let order = beginOrder(unit, field)
    expect(orderAction(order)).toEqual({ path: 0, target: 0 })

    // East then southeast: direction digits 2 and 3.
    order = clickTile(field, order, '1,0')
    order = clickTile(field, order, '1,1')
    expect(order.path.directions).toEqual([2, 3])
    expect(endpointOf(order)).toBe('1,1')
    expect(orderAction(order)).toEqual({ path: encodePath([2, 3]), target: 0 })
  })

  it('offers only legal continuations and never the four-step limit or an occupied tile', () => {
    const unit = unitAt('red_footman_0', '0,0')
    const tiles = [
      tile(0, 0),
      tile(1, 0),
      tile(2, 0),
      tile(0, 1, 'grass', 'marsh'),
      tile(1, -1, 'water'),
    ]
    const blocker = unitAt('blue_archer_0', '2,0', 'archer', 'blue')
    const field = walkFieldFor(unit, tiles, [unit, blocker])

    const order = beginOrder(unit, field)
    const offered = offeredTiles(field, order)
    // Water is impassable, the marsh costs three but the first step is always permitted.
    expect([...offered.keys()].sort()).toEqual(['0,1', '1,0'])

    // The marsh drives the balance negative, which the ruleset requires to end the path.
    const intoMarsh = clickTile(field, order, '0,1')
    expect(intoMarsh.path.remaining).toBe(-1)
    expect(offeredTiles(field, intoMarsh).size).toBe(0)

    // The occupied tile is never offered, even with the movement to reach it.
    const east = clickTile(field, order, '1,0')
    expect(offeredTiles(field, east).has('2,0')).toBe(false)

    // A click on ground that was not offered leaves the order exactly as it was.
    expect(clickTile(field, east, '2,0')).toBe(east)
  })

  it('stops offering continuations after four steps even with movement to spare', () => {
    const unit = unitAt('red_cavalry_0', '0,0', 'cavalry')
    const tiles = openField()
    const field = walkFieldFor(unit, tiles, [unit])
    let order = beginOrder(unit, field)
    for (const step of ['1,0', '2,0', '3,0', '4,0']) order = clickTile(field, order, step)
    expect(order.path.directions).toHaveLength(4)
    expect(order.path.remaining).toBe(0)
    expect(offeredTiles(field, order).size).toBe(0)
  })

  it('takes a step back from the endpoint and clears from the activated unit', () => {
    const unit = unitAt('red_cavalry_0', '0,0', 'cavalry')
    const tiles = openField()
    const field = walkFieldFor(unit, tiles, [unit])
    let order = beginOrder(unit, field)
    order = clickTile(field, order, '1,0')
    order = clickTile(field, order, '2,0')
    expect(order.path.remaining).toBe(2)

    // Clicking the endpoint removes that step and returns its movement.
    order = clickTile(field, order, '2,0')
    expect(order.path.directions).toEqual([2])
    expect(order.path.remaining).toBe(3)
    expect(undoStep(field, order).path.directions).toEqual([])

    // Clicking the activated unit clears the whole path back to stay.
    order = clickTile(field, order, '1,0')
    order = clickTile(field, order, '0,0')
    expect(order.path.directions).toEqual([])
    expect(orderAction(order)).toEqual({ path: 0, target: 0 })
  })

  it('resets a multi-step path to its origin and leaves an empty path alone', () => {
    const unit = unitAt('red_cavalry_0', '0,0', 'cavalry')
    const tiles = openField()
    const field = walkFieldFor(unit, tiles, [unit])
    let order = beginOrder(unit, field)
    order = clickTile(field, order, '1,0')
    order = clickTile(field, order, '2,0')

    const reset = resetOrder(field, order)
    expect(reset.path).toEqual({ directions: [], tiles: ['0,0'], remaining: field.movement })
    expect(orderAction(reset)).toEqual({ path: 0, target: 0 })
    expect(resetOrder(field, reset)).toBe(reset)
  })

  it('treats the origin tile as the reset even when the path could walk back onto it', () => {
    const unit = unitAt('red_cavalry_0', '0,0', 'cavalry')
    const tiles = openField()
    const field = walkFieldFor(unit, tiles, [unit])
    let order = beginOrder(unit, field)
    order = clickTile(field, order, '1,0')
    // West would walk back onto the origin, which the ruleset allows, but the origin is the reset.
    expect(offeredTiles(field, order).has('0,0')).toBe(true)
    order = clickTile(field, order, '0,0')
    expect(order.path.directions).toEqual([])
  })
})

describe('Crane Reach automatic-strike preview', () => {
  const footman = unitAt('red_footman_0', '0,0')
  const archer = unitAt('red_archer_0', '0,0', 'archer')

  it('names the unique nearest enemy in range', () => {
    const preview = strikePreview(footman, '0,0', [
      unitAt('blue_footman_0', '1,0', 'footman', 'blue'),
      unitAt('blue_archer_0', '3,0', 'archer', 'blue'),
    ])
    expect(preview).toEqual({ targets: ['blue_footman_0'], uncertain: false })
  })

  it('marks tied nearest candidates uncertain', () => {
    const preview = strikePreview(archer, '0,0', [
      unitAt('blue_footman_0', '2,0', 'footman', 'blue'),
      unitAt('blue_archer_0', '0,2', 'archer', 'blue'),
      unitAt('blue_cavalry_0', '5,0', 'cavalry', 'blue'),
    ])
    expect(preview?.uncertain).toBe(true)
    expect([...(preview?.targets ?? [])].sort()).toEqual(['blue_archer_0', 'blue_footman_0'])
  })

  it('shows nothing when no enemy is in range, and ignores allies', () => {
    expect(
      strikePreview(footman, '0,0', [unitAt('blue_footman_0', '3,0', 'footman', 'blue')]),
    ).toBeNull()
    expect(
      strikePreview(footman, '0,0', [unitAt('red_cavalry_0', '1,0', 'cavalry', 'red')]),
    ).toBeNull()
    expect(strikePreview(footman, '0,0', [])).toBeNull()
  })

  it('follows the endpoint as the path is revised', () => {
    const unit = unitAt('red_footman_0', '0,0')
    const tiles = openField()
    const enemy = unitAt('blue_archer_0', '3,0', 'archer', 'blue')
    const field = walkFieldFor(unit, tiles, [unit, enemy])
    let order = beginOrder(unit, field)
    expect(strikePreview(unit, endpointOf(order), [enemy])).toBeNull()

    order = clickTile(field, order, '1,0')
    expect(strikePreview(unit, endpointOf(order), [enemy])).toBeNull()
    order = clickTile(field, order, '2,0')
    expect(strikePreview(unit, endpointOf(order), [enemy])).toEqual({
      targets: ['blue_archer_0'],
      uncertain: false,
    })

    // Stepping back out of range drops the preview again.
    order = clickTile(field, order, '2,0')
    expect(strikePreview(unit, endpointOf(order), [enemy])).toBeNull()
  })
})

describe('Crane Reach order controls', () => {
  const live = {
    actingPlayerId: 'player_0',
    controlledPlayers: ['player_0'],
    canSend: true,
    terminal: false,
    animating: false,
    sent: false,
  }

  it('opens only on a controlled activation a viewer can actually answer', () => {
    expect(orderTurnOpen(live)).toBe(true)
    // A spectator and a replay viewer have no sender, so nothing on the board is clickable.
    expect(orderTurnOpen({ ...live, canSend: false })).toBe(false)
    // A companion turn, an opponent turn, and a finished match all close it too.
    expect(orderTurnOpen({ ...live, actingPlayerId: 'player_1' })).toBe(false)
    expect(orderTurnOpen({ ...live, actingPlayerId: null })).toBe(false)
    expect(orderTurnOpen({ ...live, terminal: true })).toBe(false)
    // The controls wait for the previous activation to finish playing out, and go inert once sent.
    expect(orderTurnOpen({ ...live, animating: true })).toBe(false)
    expect(orderTurnOpen({ ...live, sent: true })).toBe(false)
    // Whole-side control answers for every member of the seat.
    expect(
      orderTurnOpen({
        ...live,
        actingPlayerId: 'player_2',
        controlledPlayers: ['player_0', 'player_1', 'player_2'],
      }),
    ).toBe(true)
  })

  it('closes only the submitted activation, even when the first two activations share tick zero', () => {
    const renderer = Object.create(CraneReachRenderer.prototype) as {
      eventTick: number
      eventAnimating: boolean
      submittedActivation: { tick: number | null; unitId: string } | null
      ctx: { controlledPlayers: string[]; sendAction: () => void }
      controlledActor(scene: CraneReachScene): SceneUnit | null
    }
    const sceneFor = (unitId: string): CraneReachScene =>
      ({
        activation: { playerId: 'player_0', unitId },
        hud: { terminal: null },
        units: [unitAt(unitId, '0,0')],
      }) as unknown as CraneReachScene
    Object.assign(renderer, {
      eventTick: 0,
      eventAnimating: false,
      submittedActivation: { tick: 0, unitId: 'A' },
      ctx: { controlledPlayers: ['player_0'], sendAction: vi.fn() },
    })

    expect(renderer.controlledActor(sceneFor('A'))).toBeNull()
    expect(renderer.controlledActor(sceneFor('B'))?.unitId).toBe('B')
    renderer.eventTick = 1
    expect(renderer.controlledActor(sceneFor('A'))?.unitId).toBe('A')
  })

  it('marks the activation sent before the action callback can synchronously redraw', () => {
    const scene = { activation: { unitId: 'A' } } as unknown as CraneReachScene
    const renderer = Object.create(CraneReachRenderer.prototype) as {
      eventTick: number
      orderSession: { tick: number; playerId: string; order: ReturnType<typeof beginOrder> }
      presentedScene: CraneReachScene
      submittedActivation: { tick: number | null; unitId: string } | null
      ctx: { sendAction: ReturnType<typeof vi.fn> }
      reconcileOrder: ReturnType<typeof vi.fn>
      redrawCurrentFrame: ReturnType<typeof vi.fn>
      sendOrder(): void
    }
    const unit = unitAt('A', '0,0')
    const field = walkFieldFor(unit, openField(), [unit])
    const sendAction = vi.fn(() => {
      expect(renderer.submittedActivation).toEqual({ tick: 0, unitId: 'A' })
    })
    Object.assign(renderer, {
      eventTick: 0,
      orderSession: { tick: 0, playerId: 'player_0', order: beginOrder(unit, field) },
      presentedScene: scene,
      submittedActivation: null,
      ctx: { sendAction },
      reconcileOrder: vi.fn(),
      redrawCurrentFrame: vi.fn(),
    })

    renderer.sendOrder()

    expect(sendAction).toHaveBeenCalledWith('player_0', { path: 0, target: 0 })
    expect(renderer.reconcileOrder).toHaveBeenCalledWith(scene)
  })

  it('keeps inactive Reset named while making its retained hit target inert', () => {
    const layer = new Container()
    const onReset = vi.fn()
    const reset = wireOrderButtons(layer, onReset, vi.fn())

    setResetButtonActive(reset, false)
    // Pixi creates this native bridge lazily when keyboard accessibility first activates.
    const bridge = document.createElement('button')
    reset._accessibleDiv = bridge
    reset.emit('pointertap', {
      stopPropagation: vi.fn(),
    } as unknown as FederatedPointerEvent)

    expect(reset.accessible).toBe(true)
    expect(reset.accessibleType).toBe('button')
    expect(reset.accessibleTitle).toBe('Reset movement')
    expect(reset.eventMode).toBe('none')
    expect(reset.cursor).toBe('default')
    expect(bridge.disabled).toBe(true)
    expect(bridge.title).toBe('Reset movement')
    expect(onReset).not.toHaveBeenCalled()

    setResetButtonActive(reset, true)
    expect(bridge.disabled).toBe(false)
  })

  it('drains the full perimeter clockwise from the top', () => {
    const top = -Math.PI / 2
    // A full budget is the whole perimeter, and it always closes back at the top.
    expect(clockArc(1)).toEqual({ start: top, end: top + Math.PI * 2 })
    expect(clockArc(0.5)).toEqual({ start: top + Math.PI, end: top + Math.PI * 2 })
    expect(clockArc(0)).toEqual({ start: top + Math.PI * 2, end: top + Math.PI * 2 })
    // The gap opens at the top and its edge sweeps clockwise, so less time starts later.
    expect(clockArc(0.25).start).toBeGreaterThan(clockArc(0.75).start)
    for (const fraction of [1, 0.75, 0.5, 0.25, 0]) {
      expect(clockArc(fraction).end).toBe(top + Math.PI * 2)
      expect(clockArc(fraction).end - clockArc(fraction).start).toBeCloseTo(Math.PI * 2 * fraction)
    }
    // Out-of-range readings clamp rather than wrapping around into a second lap.
    expect(clockArc(2)).toEqual(clockArc(1))
    expect(clockArc(-1)).toEqual(clockArc(0))
  })

  it('pulses a reverted tile exactly once', () => {
    expect(revertPulse(0)).toBe(1)
    expect(revertPulse(REVERT_PULSE_MS / 2)).toBeCloseTo(0.5)
    expect(revertPulse(REVERT_PULSE_MS)).toBe(0)
    // It fades to nothing and stays there, so it never reads as a repeating highlight.
    expect(revertPulse(REVERT_PULSE_MS * 4)).toBe(0)
  })

  it('swells the preview across its period', () => {
    expect(previewPhase(0)).toBeCloseTo(0)
    expect(previewPhase(800)).toBeCloseTo(1)
  })

  it('fades the activation seal across its period', () => {
    expect(activationPulseAlpha(0)).toBe(1)
    expect(activationPulseAlpha(800)).toBeCloseTo(0.35)
    expect(activationPulseAlpha(1_600)).toBeCloseTo(1)
  })

  it('bakes step numerals at the supplied resolution in the mono family', () => {
    const layer = new Container()
    const numerals = new Container()
    const numeral = new Container() as ReturnType<TextFactory>
    const text = vi.fn(() => numeral) as TextFactory
    const scene = {
      hexRadius: 30,
      tiles: [tile(0, 0), tile(1, 0)],
    } as CraneReachScene
    drawOrderMarks(
      layer,
      numerals,
      text,
      scene,
      {
        order: {
          unitId: 'red_footman_0',
          path: { directions: [2], tiles: ['0,0', '1,0'], remaining: 1 },
        },
        offered: new Set(),
        preview: null,
        previewPositions: [],
        revert: null,
        clock: null,
      },
      3.5,
    )
    expect(text).toHaveBeenCalledWith(
      '1',
      15,
      expect.any(String),
      'center',
      MONO,
      expect.any(Object),
    )
    expect(numeral.resolution).toBe(3.5)
    // The numeral lands in its own container, which the renderer keeps above every piece.
    expect(numerals.children).toContain(numeral)
    expect(layer.children).not.toContain(numeral)
  })
})
