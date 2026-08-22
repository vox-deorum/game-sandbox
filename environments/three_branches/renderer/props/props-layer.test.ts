import { Container, Rectangle, Sprite, Texture } from 'pixi.js'
import { describe, expect, it } from 'vitest'

import { THREE_BRANCHES_ASSET_CATALOG } from '../assets.js'
import { sceneryVisualScale } from '../core/presentation.js'
import type { FrameScene, StaticDrawable, StaticScene } from '../core/types.js'
import { propEffectSpec } from '../effects/effects.js'
import type { FrameGrid } from '../ui/tint.js'
import { frameRectangle } from '../ui/tint.js'
import {
  createPropArt,
  createPropLayer,
  type PropLayerTargets,
  visualFacing,
} from './props-layer.js'

type PageName = 'props' | 'monuments' | 'lantern' | 'bell' | 'scenery' | 'effects'

function frameGrid(name: PageName): FrameGrid {
  const atlas = THREE_BRANCHES_ASSET_CATALOG.find((item) => item.name === name)
  if (atlas === undefined || 'layers' in atlas) {
    throw new Error(`Three Branches ${name} atlas is missing.`)
  }
  return atlas.frames
}

function page(name: PageName, source: Texture['source']): Texture {
  const grid = frameGrid(name)
  return new Texture({ source, frame: new Rectangle(0, 0, grid.width, grid.height) })
}

function layerTargets(): PropLayerTargets {
  return {
    scenery: new Container(),
    shadows: new Container(),
    props: new Container(),
    effects: new Container(),
    emissives: new Container(),
    highlight: new Container(),
  }
}

function sceneryScene(): StaticScene {
  const scenery = (
    id: string,
    type: string,
    shape: StaticDrawable['shape'],
    collisionScale: number,
    size: number,
  ): StaticDrawable => ({
    id,
    type,
    label: type,
    shape,
    collisionScale,
    rect: { x: 10, y: 20, width: size, height: size },
  })
  return {
    village: {
      size: { cellsX: 1, cellsY: 1, cellSize: 1 },
      ground: ['.'],
      buildings: [],
      props: [],
      scenery: [],
      spawn: { x: 0, y: 0 },
    },
    world: { width: 1, height: 1 },
    spawn: { x: 0, y: 0 },
    ground: [],
    groundByCode: {},
    topFirstRows: ['.'],
    buildings: [],
    props: [],
    scenery: [
      scenery('pine-1', 'pine', 'circle', 0.75, 16),
      scenery('crate-1', 'crate', 'box', 1, 32),
    ],
  }
}

function completeArt() {
  const source = Texture.WHITE.source
  return createPropArt({
    props: page('props', source),
    monuments: page('monuments', source),
    lantern: page('lantern', source),
    bell: page('bell', source),
    scenery: page('scenery', source),
    effects: page('effects', source),
  })
}

function frame(
  scene: StaticScene,
  characters: readonly (readonly [number, number])[],
  props: Record<string, string> = {},
): FrameScene {
  return {
    static: scene,
    dynamic: {
      tick: 1,
      phase: 'day',
      characters: characters.map(([x, y], index) => ({
        id: `player_${index}`,
        x,
        y,
        heading: 0,
        moved: 0,
        expression: { type: 'none', target: '' },
      })),
      props,
      terminal: false,
    },
    presentationTick: 1,
    characters: [],
  }
}

describe('Three Branches prop art views', () => {
  it('slices named views over their atlas source with manifest rectangles', () => {
    const source = Texture.WHITE.source
    const views = createPropArt({
      props: page('props', source),
      monuments: page('monuments', source),
      lantern: page('lantern', source),
      bell: page('bell', source),
      scenery: page('scenery', source),
      effects: page('effects', source),
    })

    // Every named view resolves to the manifest rectangle on its own atlas page. The exact offsets
    // are atlas calibration, so
    // they come from the manifest rather than being pinned in this suite.
    expect(views.props.stallAOpen?.source).toBe(source)
    expect(views.props.stallAOpen?.frame).toEqual(frameRectangle(frameGrid('props'), 'stallAOpen'))
    expect(views.props.lanternLit).toBeUndefined()
    expect(views.lantern.lanternLit?.frame).toEqual(
      frameRectangle(frameGrid('lantern'), 'lanternLit'),
    )
    expect(views.props.bellFoundation).toBeUndefined()
    expect(views.monuments.bellFoundation).toBeUndefined()
    expect(views.bell.bellFoundation?.frame).toEqual(
      frameRectangle(frameGrid('bell'), 'bellFoundation'),
    )
    expect(views.scenery.marketCrate?.frame).toEqual(
      frameRectangle(frameGrid('scenery'), 'marketCrate'),
    )
    expect(views.scenery.pineA?.frame).toEqual(new Rectangle(0, 0, 512, 512))
    expect(views.scenery.pineF?.frame).toEqual(new Rectangle(512, 512, 512, 512))
    expect(views.scenery.marketCrate?.frame).toEqual(new Rectangle(1024, 512, 512, 512))
    expect(views.monuments.pumpFlowing?.frame).toEqual(
      frameRectangle(frameGrid('monuments'), 'pumpFlowing'),
    )
    expect(views.effects.flameA?.frame).toEqual(frameRectangle(frameGrid('effects'), 'flameA'))
  })

  it('scales circular scenery by collision size and box scenery by footprint', () => {
    const targets = layerTargets()
    const props = createPropLayer(targets, sceneryScene())
    props.install(completeArt())

    const pines = targets.effects.getChildByLabel('pines')
    expect(pines).toBeInstanceOf(Container)
    const pineRoot = (pines as Container).getChildByLabel('scenery:pine-1')
    const crateRoot = targets.scenery.getChildByLabel('scenery:crate-1')
    expect(pineRoot).toBeInstanceOf(Container)
    expect(crateRoot).toBeInstanceOf(Container)
    const pine = (pineRoot as Container).getChildByLabel('scenery-art')
    const crate = (crateRoot as Container).getChildByLabel('scenery-art')
    expect(pine).toBeInstanceOf(Sprite)
    expect(crate).toBeInstanceOf(Sprite)
    expect((pine as Sprite).scale.x).toBe((sceneryVisualScale('pine') * 0.75) / 8)
    expect((crate as Sprite).scale.x).toBe((sceneryVisualScale('crate') * 2) / 8)
    expect((crate as Sprite).width).toBe(32)
    expect(sceneryVisualScale('crate')).toBe(sceneryVisualScale('unknown'))
    expect((pine as Sprite).tint).toBe(0xffffff)
    expect((crate as Sprite).tint).toBe(0xffffff)
  })

  it('keeps pines above prop effects and cuts them out only for occupied buildings', () => {
    const targets = layerTargets()
    const scene = sceneryScene()
    const building: StaticDrawable = {
      id: 'home_0',
      type: 'home',
      label: 'home',
      shape: 'box',
      collisionScale: 1,
      rect: { x: 0, y: 0, width: 32, height: 32 },
    }
    scene.buildings = [building]
    scene.props = [
      {
        id: 'bench_0',
        type: 'bench',
        label: 'bench',
        shape: 'box',
        collisionScale: 1,
        rect: { x: 40, y: 40, width: 8, height: 8 },
      },
    ]
    const props = createPropLayer(targets, scene)
    const pines = targets.effects.getChildByLabel('pines') as Container
    const cutout = targets.effects.getChildByLabel('pine-building-cutout') as Container

    expect(targets.effects.children.map((child) => child.label)).toEqual([
      'prop-effect:bench_0',
      'pines',
      'pine-building-cutout',
    ])
    expect(pines.mask).toBe(cutout)
    expect(
      (pines as Container & { _maskOptions?: { inverse?: boolean } })._maskOptions?.inverse,
    ).toBe(true)

    props.reconcile(frame(scene, [[0.5, 0.5]]))
    expect(cutout.getLocalBounds()).toMatchObject({ x: 0, y: 0, width: 32, height: 32 })
    props.reconcile(frame(scene, [[3, 3]]))
    expect(cutout.getLocalBounds()).toMatchObject({ width: 0, height: 0 })
  })

  it('preflights every approved pine frame', () => {
    const targets = layerTargets()
    const props = createPropLayer(targets, sceneryScene())
    const art = completeArt()
    const scenery = Object.fromEntries(
      Object.entries(art.scenery).filter(([name]) => name !== 'pineF'),
    )

    expect(() => props.install({ ...art, scenery })).toThrow(/prop frame is missing: pineF/)
  })
})

function propScene(...props: StaticDrawable[]): StaticScene {
  const scene = sceneryScene()
  scene.scenery = []
  scene.props = props
  return scene
}

function drawable(type: string, id: string, collisionScale: number = 1): StaticDrawable {
  return {
    id,
    type,
    label: type,
    shape: type === 'lantern' || type === 'pump' || type === 'bell' ? 'circle' : 'box',
    collisionScale,
    rect: { x: 0, y: 0, width: 16, height: 16 },
    facing: 'east',
  }
}

function sprite(root: Container, label: string): Sprite {
  const node = root.getChildByLabel(label)
  if (!(node instanceof Sprite)) throw new Error(`Expected sprite ${label}.`)
  return node
}

describe('Three Branches registered prop layers', () => {
  it('keeps ordinary artwork in the lower prop layer only', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('bench', 'bench_0'))
    createPropLayer(targets, scene).install(completeArt())

    const lower = targets.props.getChildByLabel('prop-lower:bench_0') as Container
    expect(sprite(lower, 'prop-lower-art').visible).toBe(true)
    expect(targets.effects.getChildByLabel('prop-upper:bench_0')).toBeNull()
  })

  it('keeps each stall id on one construction across state, facing, reconcile, and reinstall', () => {
    const targets = layerTargets()
    const stalls = ['stall_0', 'stall_1', 'stall_2', 'stall_3', 'stall_4'].map((id) =>
      drawable('stall', id),
    )
    const scene = propScene(...stalls)
    const layer = createPropLayer(targets, scene)
    const art = completeArt()
    layer.install(art)

    const stallFrames = () =>
      stalls.map((item) => {
        const root = targets.props.getChildByLabel(`prop-lower:${item.id}`) as Container
        return sprite(root, 'prop-lower-art').texture.frame
      })
    expect(stallFrames()).toEqual(
      ['stallAClosed', 'stallBClosed', 'stallCClosed', 'stallAClosed', 'stallBClosed'].map((name) =>
        frameRectangle(frameGrid('props'), name),
      ),
    )

    layer.reconcile(frame(scene, [], Object.fromEntries(stalls.map((item) => [item.id, 'open']))))
    layer.advance(1)
    expect(stallFrames()).toEqual(
      ['stallAOpen', 'stallBOpen', 'stallCOpen', 'stallAOpen', 'stallBOpen'].map((name) =>
        frameRectangle(frameGrid('props'), name),
      ),
    )
    expect(
      stalls.map((item) => {
        const root = targets.props.getChildByLabel(`prop-lower:${item.id}`) as Container
        return root.rotation
      }),
    ).toEqual(Array(5).fill((3 * Math.PI) / 2))

    layer.install(art)
    expect(stallFrames()).toEqual(
      ['stallAOpen', 'stallBOpen', 'stallCOpen', 'stallAOpen', 'stallBOpen'].map((name) =>
        frameRectangle(frameGrid('props'), name),
      ),
    )
  })

  it('preflights every approved stall construction and state', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('stall', 'stall_0'))
    const layer = createPropLayer(targets, scene)
    const art = completeArt()
    const props = Object.fromEntries(
      Object.entries(art.props).filter(([name]) => name !== 'stallCOpen'),
    )

    expect(() => layer.install({ ...art, props })).toThrow(
      /prop frame is missing: props.stallCOpen/,
    )
  })

  it('splits the pump across layers with its registered density and anchor', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('pump', 'pump_0', 0.75))
    createPropLayer(targets, scene).install(completeArt())

    const lower = targets.props.getChildByLabel('prop-lower:pump_0') as Container
    const upper = targets.effects.getChildByLabel('prop-upper:pump_0') as Container
    const lowerArt = sprite(lower, 'prop-lower-art')
    expect(lowerArt.visible).toBe(true)
    const art = sprite(upper, 'prop-upper-art')
    const full = frameRectangle(frameGrid('monuments'), 'pumpIdle')
    expect(art.visible).toBe(true)
    expect(art.scale.x).toBe(0.33 / 4)
    expect(art.texture.frame).toEqual(new Rectangle(full.x, full.y, full.width, 304))
    expect(lowerArt.texture.frame).toEqual(new Rectangle(full.x, full.y + 304, full.width, 208))
    expect(art.anchor).toMatchObject({ x: 344 / 768, y: 384 / 304 })
    expect(lowerArt.anchor).toMatchObject({ x: 344 / 768, y: (384 - 304) / 208 })
    expect(lower.parent).toBe(targets.props)
    expect(upper.parent).toBe(targets.effects)
    expect(lower.position.x).toBe(upper.position.x)
    expect(lower.position.y).toBe(upper.position.y)
    expect(lower.rotation).toBe(upper.rotation)
  })

  it('splits the bell foundation, fixed gantry, and moving upper piece across layers', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('bell', 'bell_0'))
    createPropLayer(targets, scene).install(completeArt())

    const lower = sprite(
      targets.props.getChildByLabel('prop-lower:bell_0') as Container,
      'prop-lower-art',
    )
    const upper = sprite(
      targets.effects.getChildByLabel('prop-upper:bell_0') as Container,
      'prop-upper-art',
    )
    const movingRoot = upper.parent?.getChildByLabel('prop-moving-root') as Container
    const moving = sprite(movingRoot, 'prop-moving-art')
    expect(lower.texture.frame).toEqual(frameRectangle(frameGrid('bell'), 'bellFoundation'))
    expect(upper.texture.frame).toEqual(frameRectangle(frameGrid('bell'), 'bellGantry'))
    expect(moving.texture.frame).toEqual(frameRectangle(frameGrid('bell'), 'bellMoving'))
    expect(lower.anchor).toMatchObject({ x: 0.5, y: 0.5 })
    expect(upper.anchor).toMatchObject({ x: 0.5, y: 960 / 1024 })
    expect(moving.anchor).toMatchObject({ x: 0.5, y: 960 / 1024 })
    expect(movingRoot.label).toBe('prop-moving-root')
    expect(movingRoot.pivot).toMatchObject({ x: 0, y: (527 - 960) * (0.36 / 16) })
    expect(movingRoot.position).toMatchObject({ x: 0, y: (527 - 960) * (0.36 / 16) })
    expect(lower.scale.x).toBe(0.36 / 16)
    expect(upper.scale.x).toBe(0.36 / 16)
    expect(moving.scale.x).toBe(0.36 / 16)
  })

  it('keeps the silent bell registered and swings only its circular piece while ringing', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('bell', 'bell_0'))
    const layer = createPropLayer(targets, scene)
    layer.install(completeArt())
    layer.reconcile(frame(scene, [], { bell_0: 'silent' }))
    const upper = targets.effects.getChildByLabel('prop-upper:bell_0') as Container
    const movingRoot = upper.getChildByLabel('prop-moving-root') as Container
    const moving = sprite(movingRoot, 'prop-moving-art')
    const gantry = sprite(upper, 'prop-upper-art')
    layer.advance(0.25)
    expect(movingRoot.rotation).toBe(0)
    expect(moving.position).toMatchObject({ x: 0, y: 0 })
    layer.reconcile(frame(scene, [], { bell_0: 'ringing' }))
    layer.advance(0.25)
    const first = movingRoot.rotation
    expect(first).not.toBe(0)
    layer.advance(0.5)
    expect(movingRoot.rotation).not.toBe(first)
    expect(Math.abs(movingRoot.rotation)).toBeLessThanOrEqual(0.18)
    expect(moving.position).toMatchObject({ x: 0, y: 0 })
    expect(gantry.rotation).toBe(0)
  })

  it('keeps a centered lower-only lantern state stable across complete textures', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('lantern', 'lantern_0'))
    const layer = createPropLayer(targets, scene)
    layer.install(completeArt())
    layer.reconcile(frame(scene, [], { lantern_0: 'lit' }))
    layer.advance(1)

    const lower = sprite(
      targets.props.getChildByLabel('prop-lower:lantern_0') as Container,
      'prop-lower-art',
    )
    expect(lower.texture.frame).toEqual(frameRectangle(frameGrid('lantern'), 'lanternLit'))
    expect(lower.anchor).toMatchObject({ x: 0.5, y: 0.5 })
    expect(lower.scale.x).toBe(0.1)
    expect(targets.effects.getChildByLabel('prop-upper:lantern_0')).toBeNull()
    expect(targets.effects.getChildByLabel('prop-effect:lantern_0')?.position).toMatchObject({
      x: 8,
      y: 8,
    })
    expect(targets.emissives.getChildByLabel('prop-emissive:lantern_0')?.position).toMatchObject({
      x: 8,
      y: 8,
    })
    const litLower = lower.texture

    layer.reconcile(frame(scene, [], { lantern_0: 'unlit' }))
    expect(lower.texture.frame).toEqual(frameRectangle(frameGrid('lantern'), 'lanternUnlit'))

    layer.reconcile(frame(scene, [], { lantern_0: 'lit' }))
    expect(lower.texture).toBe(litLower)
  })

  it('aligns the tended shrine cloud and reproduces its full opacity cycle on seek', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('shrine', 'shrine_0'))
    const layer = createPropLayer(targets, scene)
    layer.install(completeArt())
    layer.reconcile(frame(scene, [], { shrine_0: 'tended' }))

    const effect = targets.effects.getChildByLabel('prop-effect:shrine_0') as Sprite
    const initial = propEffectSpec('shrine', 'tended', 'shrine_0', 0)
    if (initial === null) throw new Error('Expected a tended shrine effect.')
    const troughTick = (1 - initial.phase / 0xffffffff) * 8
    const peakTick = troughTick + 4

    layer.advance(troughTick)
    expect(effect.visible).toBe(true)
    expect(effect.texture.frame).toEqual(frameRectangle(frameGrid('effects'), 'shrineCloud'))
    expect(effect.position).toMatchObject({ x: 8, y: 8 })
    expect(effect.scale.x).toBeCloseTo(0.4)
    expect(effect.rotation).toBe(0)
    expect(effect.alpha).toBeCloseTo(0)

    layer.advance(peakTick)
    expect(effect.alpha).toBeCloseTo(1)
    layer.advance(troughTick)
    expect(effect.alpha).toBeCloseTo(0)

    layer.reconcile(frame(scene, [], { shrine_0: 'untended' }))
    layer.advance(troughTick)
    expect(effect.visible).toBe(false)
  })

  it('keeps a one-cell lantern shadow and highlight independent of dedicated artwork', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('lantern', 'lantern_0'))
    const layer = createPropLayer(targets, scene)
    layer.install(completeArt())
    layer.highlight('lantern_0')

    const shadow = targets.shadows.getChildByLabel('prop-contact-shadow:lantern_0') as Sprite
    expect(shadow.scale.x).toBeCloseTo(0.1)
    expect(shadow.scale.y).toBe(0.09375)
    expect(targets.highlight.getLocalBounds()).toMatchObject({
      minX: -3,
      minY: -3,
      maxX: 19,
      maxY: 19,
    })
  })

  it('keeps the installed lower-only lantern state when replacement preflight fails', () => {
    const targets = layerTargets()
    const scene = propScene(drawable('lantern', 'lantern_0'))
    const layer = createPropLayer(targets, scene)
    const art = completeArt()
    layer.install(art)
    layer.reconcile(frame(scene, [], { lantern_0: 'lit' }))
    const lower = sprite(
      targets.props.getChildByLabel('prop-lower:lantern_0') as Container,
      'prop-lower-art',
    )
    const installedLower = lower.texture
    const lantern = Object.fromEntries(
      Object.entries(art.lantern).filter(([name]) => name !== 'lanternLit'),
    )

    expect(() => layer.install({ ...art, lantern })).toThrow(
      /prop frame is missing: lantern.lanternLit/,
    )
    expect(lower.texture).toBe(installedLower)
  })
})

describe('Three Branches prop visual facing', () => {
  const drawable = (type: string, facing?: string): StaticDrawable => ({
    id: `${type}-test`,
    type,
    label: type,
    shape: 'box',
    collisionScale: 1,
    rect: { x: 0, y: 0, width: 1, height: 1 },
    facing,
  })

  it('turns an east-facing bench by a quarter turn', () => {
    expect(visualFacing(drawable('bench', 'east'))).toBe(Math.PI / 2)
  })

  it('turns a north-facing stall half a turn round from its standing', () => {
    expect(visualFacing(drawable('stall', 'north'))).toBe(Math.PI)
  })

  it('turns an east-facing stall half a turn past the quarter turn', () => {
    expect(visualFacing(drawable('stall', 'east'))).toBe((3 * Math.PI) / 2)
  })

  it('keeps an east-facing lantern fixed north', () => {
    expect(visualFacing(drawable('lantern', 'east'))).toBe(0)
  })

  it('keeps an east-facing shrine fixed north', () => {
    expect(visualFacing(drawable('shrine', 'east'))).toBe(0)
  })

  it('keeps an east-facing pump fixed north', () => {
    expect(visualFacing(drawable('pump', 'east'))).toBe(0)
  })

  it('keeps an east-facing bell fixed north', () => {
    expect(visualFacing(drawable('bell', 'east'))).toBe(0)
  })

  it('keeps an east-facing board fixed north', () => {
    expect(visualFacing(drawable('board', 'east'))).toBe(0)
  })

  it('defaults an undefined facing to north', () => {
    expect(visualFacing(drawable('bench'))).toBe(0)
  })
})
