import { metresToWorld } from './scene.js'
import type { CollisionShape, FrameScene, StaticScene } from './types.js'

/** Derive collision from configured passability and catalog geometry, matching the engine's sources. */
export function staticCollision(scene: StaticScene): readonly CollisionShape[] {
  const shapes: CollisionShape[] = []
  const cell = metresToWorld(scene.village.size.cellSize)
  for (const [sourceRow, row] of scene.village.ground.entries()) {
    for (const [column, code] of [...row].entries()) {
      const ground = scene.groundByCode[code]
      if (ground?.passable !== false) continue
      shapes.push({
        id: `ground:${column}:${sourceRow}`,
        kind: 'rect',
        rect: {
          x: column * cell,
          y: (scene.village.size.cellsY - sourceRow - 1) * cell,
          width: cell,
          height: cell,
        },
        label: ground.name,
        group: 'blocked',
      })
    }
  }
  for (const item of [...scene.props, ...scene.scenery]) {
    // The scene already turned the rectangle to its facing. Engine solids stay axis-aligned.
    if (item.shape === 'box') {
      shapes.push({
        id: item.id,
        kind: 'rect',
        rect: item.rect,
        label: item.label,
        group: 'object',
      })
    } else {
      shapes.push({
        id: item.id,
        kind: 'circle',
        center: { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 },
        radius: Math.min(item.rect.width, item.rect.height) / 2,
        label: item.label,
        group: 'object',
      })
    }
  }
  const edge = 2
  shapes.push(
    {
      id: 'boundary:north',
      kind: 'rect',
      rect: { x: 0, y: 0, width: scene.world.width, height: edge },
      label: 'boundary',
      group: 'boundary',
    },
    {
      id: 'boundary:east',
      kind: 'rect',
      rect: { x: scene.world.width - edge, y: 0, width: edge, height: scene.world.height },
      label: 'boundary',
      group: 'boundary',
    },
    {
      id: 'boundary:south',
      kind: 'rect',
      rect: { x: 0, y: scene.world.height - edge, width: scene.world.width, height: edge },
      label: 'boundary',
      group: 'boundary',
    },
    {
      id: 'boundary:west',
      kind: 'rect',
      rect: { x: 0, y: 0, width: edge, height: scene.world.height },
      label: 'boundary',
      group: 'boundary',
    },
  )
  return shapes
}

/** Add current character bodies to the static collision truth. */
export function frameCollision(scene: FrameScene): readonly CollisionShape[] {
  return scene.characters.map((character) => ({
    id: character.id,
    kind: 'circle' as const,
    center: character.point,
    radius: character.radius,
    label: character.label,
    group: 'character' as const,
  }))
}

/** Add the current configured state to interactive prop labels without changing collision geometry. */
export function collisionWithPropStates(
  shapes: readonly CollisionShape[],
  scene: FrameScene | null,
): readonly CollisionShape[] {
  if (scene === null || scene.dynamic === null) return shapes
  const dynamic = scene.dynamic
  const labels = new Map(
    scene.static.props.map((prop) => [
      prop.id,
      `${prop.label}: ${dynamic.props[prop.id] ?? 'unknown'}`,
    ]),
  )
  return shapes.map((shape) => {
    const label = labels.get(shape.id)
    return label === undefined ? shape : { ...shape, label }
  })
}
