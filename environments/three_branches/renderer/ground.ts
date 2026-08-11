/** The single immutable Tilemap and its seeded Hearthside ground washes. */
import {
  createTiledGround,
  type GroundTileset,
  type TiledGround,
} from '@renderers/base/tiled-ground.js'
import { Container, Sprite, Texture, type TextureSource } from 'pixi.js'

import type { ThreeBranchesAssetName } from './assets.js'
import { WORLD_SCALE } from './geometry.js'
import { PRESENTATION, showsGroundMark, variantFor } from './presentation.js'
import type { Palette, StaticScene } from './scene.js'

interface WashBinding {
  name: ThreeBranchesAssetName
  sprite: Sprite
  width: number
  height: number
}

export interface HearthsideGround extends TiledGround {
  /** Seeded mask instances share the ground layer and never rebuild on a tick or seek. */
  setTextures(textureFor: (name: ThreeBranchesAssetName) => Texture | null): void
}

/** Build one Tilemap plus deterministic mask instances for the full one-hundred-meter grid. */
export function createGround(scene: StaticScene, palette: Palette): HearthsideGround {
  const { tileset, owned } = flatTileset(palette)
  const tilemap = createTiledGround({ columns: 100, rows: scene.tileRows }, tileset, {
    cellSize: WORLD_SCALE,
  })
  const washes = new Container()
  washes.eventMode = 'none'
  const bindings: WashBinding[] = []
  const paper = new Sprite(Texture.EMPTY)
  paper.width = WORLD_SCALE * 100
  paper.height = WORLD_SCALE * 100
  paper.alpha = 0.12
  washes.addChild(paper)
  bindings.push({
    name: 'paperField',
    sprite: paper,
    width: WORLD_SCALE * 100,
    height: WORLD_SCALE * 100,
  })
  // Marks cover a block of cells rather than one, so the brushwork keeps the scale it was drawn at
  // instead of being squeezed into a metre and reading as a grid of squares.
  const block = PRESENTATION.ground.markCells
  const span = block * WORLD_SCALE
  for (let row = 0; row < scene.tileRows.length; row += block) {
    for (let column = 0; column < 100; column += block) {
      if (!showsGroundMark(scene.layoutKey, column, row)) continue
      const code = centerCode(scene.tileRows, column, row, block)
      const name = PRESENTATION.ground.marks[code]?.[variantFor(scene.layoutKey, code, column, row)]
      if (name === undefined) continue
      const sprite = new Sprite(Texture.EMPTY)
      sprite.position.set(column * WORLD_SCALE, row * WORLD_SCALE)
      sprite.width = span
      sprite.height = span
      sprite.alpha = 0.16
      sprite.tint = palette.ink
      washes.addChild(sprite)
      bindings.push({ name, sprite, width: span, height: span })
    }
  }
  tilemap.view.addChild(washes)
  const ownedGround = withOwnedTextures(tilemap, owned)
  return {
    ...ownedGround,
    setTextures(textureFor) {
      for (const binding of bindings) {
        binding.sprite.texture = textureFor(binding.name) ?? Texture.EMPTY
        binding.sprite.width = binding.width
        binding.sprite.height = binding.height
      }
    },
  }
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

/** The ground code at the middle of a mark's block, so one mark suits the ground it covers. */
function centerCode(rows: string[], column: number, row: number, block: number): string {
  const middle = block >> 1
  const line = rows[Math.min(rows.length - 1, row + middle)] ?? ''
  return line[Math.min(line.length - 1, column + middle)] ?? ''
}

/**
 * One flat color per ground code. Texture comes from the paper wash and the block marks above,
 * never from the cells themselves: a mark inside a one-metre tile lands on every tile in the world
 * and turns the whole village into a lattice.
 */
function flatTileset(palette: Palette): { tileset: GroundTileset; owned: Set<Texture> } {
  const textures: Record<string, Texture> = {}
  const owned = new Set<Texture>()
  for (const [code, base] of Object.entries(palette.ground)) {
    const canvas = document.createElement('canvas')
    canvas.width = WORLD_SCALE
    canvas.height = WORLD_SCALE
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('A 2D canvas is required to create Hearthside ground.')
    context.fillStyle = base
    context.fillRect(0, 0, WORLD_SCALE, WORLD_SCALE)
    const texture = Texture.from(canvas as unknown as TextureSource)
    owned.add(texture)
    textures[code] = texture
  }
  return { tileset: { tileSize: WORLD_SCALE, textures }, owned }
}
