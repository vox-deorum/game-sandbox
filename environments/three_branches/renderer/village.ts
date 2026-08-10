/** Static placeholder village marks above the tiled ground. */
import { Container, Graphics } from 'pixi.js'

import type { Palette, StaticScene, WorldLine } from './scene.js'

/** Draw every immutable village feature once for a decoded header. */
export function createVillage(scene: StaticScene, palette: Palette): Container {
  const layer = new Container()
  const waterways = new Graphics()
  for (const channel of scene.channels) drawLine(waterways, channel, '#4e86a5')
  layer.addChild(waterways)

  const paths = new Graphics()
  drawLine(paths, scene.road, '#b28c62')
  for (const footpath of scene.footpaths) drawLine(paths, footpath, '#d0ae7d')
  layer.addChild(paths)

  const buildings = new Graphics()
  for (const building of scene.buildings) {
    const [first, ...rest] = building.corners
    if (first === undefined) continue
    buildings.moveTo(first.x, first.y)
    for (const corner of rest) buildings.lineTo(corner.x, corner.y)
    buildings
      .closePath()
      .fill(palette.buildingFill)
      .stroke({ color: palette.buildingOutline, width: 3 })
  }
  layer.addChild(buildings)

  for (const bridge of scene.bridges) {
    const bridgeNode = new Graphics()
    bridgeNode
      .rect(-bridge.span / 2, -bridge.width / 2, bridge.span, bridge.width)
      .fill(palette.bridge)
      .stroke({ color: palette.buildingOutline, width: 2 })
    bridgeNode.position.set(bridge.position.x, bridge.position.y)
    bridgeNode.rotation = (bridge.heading * Math.PI) / 180
    layer.addChild(bridgeNode)
  }

  const scenery = new Graphics()
  for (const item of scene.scenery) {
    scenery.circle(item.position.x, item.position.y, item.radius).fill(palette.scenery)
  }
  layer.addChild(scenery)

  const spawn = new Graphics()
  spawn.circle(scene.spawn.x, scene.spawn.y, 7).stroke({ color: '#ffffff', width: 2 })
  spawn
    .moveTo(scene.spawn.x - 10, scene.spawn.y)
    .lineTo(scene.spawn.x + 10, scene.spawn.y)
    .stroke({ color: '#ffffff', width: 1 })
  spawn
    .moveTo(scene.spawn.x, scene.spawn.y - 10)
    .lineTo(scene.spawn.x, scene.spawn.y + 10)
    .stroke({ color: '#ffffff', width: 1 })
  layer.addChild(spawn)
  return layer
}

function drawLine(graphics: Graphics, line: WorldLine, color: string): void {
  const [first, ...rest] = line.points
  if (first === undefined) return
  graphics.moveTo(first.x, first.y)
  for (const point of rest) graphics.lineTo(point.x, point.y)
  graphics.stroke({ color, width: line.width, cap: 'round', join: 'round' })
}
