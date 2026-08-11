/** Small Pixi helpers shared by retained environment renderers. */
import { Sprite, Texture } from 'pixi.js'

/** A point shape accepted by Pixi polygon drawing and hit areas. */
export interface RenderPoint {
  x: number
  y: number
}

/** Flatten point objects into the alternating coordinates Pixi polygon APIs expect. */
export function flattenPoints(points: readonly RenderPoint[]): number[] {
  return points.flatMap((point) => [point.x, point.y])
}

/** Create an empty sprite whose texture is centered on its local origin. */
export function centeredSprite(): Sprite {
  const sprite = new Sprite(Texture.EMPTY)
  sprite.anchor.set(0.5)
  return sprite
}

/** Apply an optional texture at a fixed size and hide the sprite while the texture is absent. */
export function applyTexture(
  sprite: Sprite,
  texture: Texture | null,
  width: number,
  height: number,
): void {
  sprite.texture = texture ?? Texture.EMPTY
  sprite.width = width
  sprite.height = height
  sprite.visible = texture !== null
}
