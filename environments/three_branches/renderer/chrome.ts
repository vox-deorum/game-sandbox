import { type Container, Graphics, Text } from 'pixi.js'

import { PALETTE, THREE_BRANCHES_PRESENTATION } from './presentation.js'
import type { FrameScene } from './types.js'

/** Fixed logical hit rectangle for the collision overlay control. */
export const COLLISION_TOGGLE_RECT = { x: 1000, y: 5, width: 184, height: 44 } as const

/** Retained fixed-chrome lifecycle. */
export interface ChromeLayer {
  /** Reconcile labels and the collision control toward one frame. */
  update(
    scene: FrameScene,
    fallbackTick: number,
    collisionVisible: boolean,
    resolution: number,
  ): void
}

/**
 * Build the fixed diagnostic strip and its permanent collision toggle.
 *
 * The plate is drawn here and clicked in the browser's own coordinates by the renderer, which is
 * how every other gesture in this environment is answered. {@link COLLISION_TOGGLE_RECT} is the
 * one statement of where it is, shared by the drawing, the hit band, and the probe.
 */
export function createChrome(layer: Container): ChromeLayer {
  layer.addChild(
    new Graphics()
      .rect(
        0,
        0,
        THREE_BRANCHES_PRESENTATION.internalSize.width,
        THREE_BRANCHES_PRESENTATION.chromeHeight,
      )
      .fill(PALETTE.chrome),
  )
  const status = textAt(layer, 16, 27, 19)
  const bell = textAt(layer, 580, 27, 15)
  const button = new Graphics()
    .roundRect(
      COLLISION_TOGGLE_RECT.x,
      COLLISION_TOGGLE_RECT.y,
      COLLISION_TOGGLE_RECT.width,
      COLLISION_TOGGLE_RECT.height,
      7,
    )
    .fill(PALETTE.backdrop)
    .stroke({ color: PALETTE.muted, width: 1 })
  layer.addChild(button)
  const toggle = textAt(
    layer,
    COLLISION_TOGGLE_RECT.x + COLLISION_TOGGLE_RECT.width / 2,
    COLLISION_TOGGLE_RECT.y + COLLISION_TOGGLE_RECT.height / 2,
    15,
  )
  toggle.anchor.set(0.5)
  return {
    update(scene, fallbackTick, collisionVisible, resolution) {
      const dynamic = scene.dynamic
      status.text =
        dynamic === null
          ? `Opening · Tick ${fallbackTick}`
          : `${dynamic.phase} · Tick ${dynamic.tick}${dynamic.terminal ? ' · Complete' : ''}`
      const bellProp = scene.static.props.find((prop) => prop.type === 'bell')
      bell.text =
        bellProp === undefined || dynamic === null
          ? ''
          : `Bell: ${dynamic.props[bellProp.id] ?? 'unknown'}`
      toggle.text = `Collision: ${collisionVisible ? 'On' : 'Off'}`
      status.resolution = resolution
      bell.resolution = resolution
      toggle.resolution = resolution
    },
  }
}

function textAt(layer: Container, x: number, y: number, size: number): Text {
  const value = new Text({
    text: '',
    style: { fill: PALETTE.text, fontFamily: 'system-ui, sans-serif', fontSize: size },
  })
  value.anchor.set(0, 0.5)
  value.position.set(x, y)
  layer.addChild(value)
  return value
}
