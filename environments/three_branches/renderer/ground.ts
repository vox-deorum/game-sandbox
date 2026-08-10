/** Pixi ground layer backed by the shared tiled-map wrapper. */
import {
  createTiledGround,
  solidColorTileset,
  type TiledGround,
} from '@renderers/base/tiled-ground.js'
import type { Texture } from 'pixi.js'

import { WORLD_SCALE } from './geometry.js'
import type { Palette, StaticScene } from './scene.js'

/** Build the immutable hundred-by-hundred village floor. */
export function createGround(scene: StaticScene, palette: Palette): TiledGround {
  const tileset = solidColorTileset(palette.ground)
  const ground = createTiledGround({ columns: 100, rows: scene.tileRows }, tileset, {
    cellSize: WORLD_SCALE,
  })
  const textures = new Set<Texture>(
    Object.values(tileset.textures).flatMap((source) =>
      Array.isArray(source) ? source : [source],
    ),
  )
  return withOwnedTextures(ground, textures)
}

/** Attach the lifetime of fresh renderer-owned textures to their ground layer. */
export function withOwnedTextures(ground: TiledGround, textures: Iterable<Texture>): TiledGround {
  let destroyed = false

  return {
    ...ground,
    destroy() {
      if (destroyed) return
      destroyed = true
      ground.destroy()
      for (const texture of textures) texture.destroy(true)
    },
  }
}
