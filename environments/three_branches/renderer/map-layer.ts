import {
  createTiledGround,
  type GroundTileset,
  solidColorTileset,
  type TiledGround,
} from '@renderers/base/tiled-ground.js'
import type { Container } from 'pixi.js'

import { THREE_BRANCHES_PRESENTATION } from './presentation.js'
import type { StaticScene } from './types.js'

/** Draw the configured ground as one packed base, landscape, and structure map. */
export function drawMap(
  layer: Container,
  scene: StaticScene,
  artTileset?: GroundTileset,
): TiledGround {
  const baseCode = scene.ground.find((item) => item.layer === 'base')?.code
  if (baseCode === undefined) throw new Error('Three Branches rules do not define a fill ground.')
  const rowsFor = (wanted: 'landscape' | 'structure'): string[] =>
    scene.topFirstRows.map((row) =>
      [...row].map((code) => (scene.groundByCode[code]?.layer === wanted ? code : ' ')).join(''),
    )
  const baseRows = scene.topFirstRows.map(() => baseCode.repeat(scene.village.size.cellsX))
  const colors = Object.fromEntries(scene.ground.map((ground) => [ground.code, ground.color]))
  const tileset = artTileset ?? solidColorTileset(colors)
  const ground = createTiledGround(
    { columns: scene.village.size.cellsX, rows: baseRows },
    tileset,
    {
      cellSize: THREE_BRANCHES_PRESENTATION.unitsPerMetre * scene.village.size.cellSize,
      layers: [
        { columns: scene.village.size.cellsX, rows: rowsFor('landscape') },
        { columns: scene.village.size.cellsX, rows: rowsFor('structure') },
      ],
    },
  )
  layer.addChild(ground.view)
  return ground
}
