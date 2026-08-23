import { Container, type Graphics, type Text } from 'pixi.js'
import { describe, expect, it, vi } from 'vitest'
import { testText } from '../core/test-helpers.js'
import type { CollisionShape } from '../core/types.js'
import { type CollisionLayer, createCollisionLayer } from './collision-layer.js'

function objectRect(id: string, x: number, y: number, label: string): CollisionShape {
  return { id, kind: 'rect', rect: { x, y, width: 40, height: 30 }, label, group: 'object' }
}

function body(id: string, x: number, y: number, label = id): CollisionShape {
  return { id, kind: 'circle', center: { x, y }, radius: 8, label, group: 'character' }
}

interface Mounted {
  layer: Container
  createText: ReturnType<typeof vi.fn>
  collision: CollisionLayer
  staticShapes: Graphics
  staticLabels: Container
  dynamicShapes: Graphics
  dynamicLabels: Container
}

/** Mount the layer the way the renderer does, keeping the child layers inspectable. */
function mount(): Mounted {
  const createText = vi.fn(
    (
      value: string,
      size: number,
      fill: string,
      align: 'left' | 'center' | 'right',
      fontFamily: string | undefined,
      stroke: { color: string; width: number } | undefined,
    ) => testText(value, size, fill, align, fontFamily, stroke),
  )
  const layer = new Container()
  const collision = createCollisionLayer(layer, createText)
  return {
    layer,
    createText,
    collision,
    staticShapes: layer.children[0] as Graphics,
    staticLabels: layer.children[1] as Container,
    dynamicShapes: layer.children[2] as Graphics,
    dynamicLabels: layer.children[3] as Container,
  }
}

describe('Three Branches collision layer', () => {
  it('stays inert while hidden: draws record shapes without labels or geometry', () => {
    const {
      layer,
      createText,
      collision,
      staticShapes,
      staticLabels,
      dynamicShapes,
      dynamicLabels,
    } = mount()
    collision.drawStatic(
      [objectRect('crate_0', 10, 20, 'crate'), body('tree_0', 30, 40, 'tree')],
      1,
    )
    collision.drawDynamic([body('player_0', 30, 40), body('player_1', 50, 60)], 1)
    expect(layer.visible).toBe(false)
    expect(createText).not.toHaveBeenCalled()
    expect(staticLabels.children).toHaveLength(0)
    expect(dynamicLabels.children).toHaveLength(0)
    expect(staticShapes.context.instructions).toHaveLength(0)
    expect(dynamicShapes.context.instructions).toHaveLength(0)
  })

  it('paints the latest stored static and dynamic shapes when revealed', () => {
    const { layer, collision, staticLabels, dynamicLabels } = mount()
    collision.drawStatic(
      [objectRect('crate_0', 10, 20, 'crate'), body('tree_0', 30, 40, 'tree')],
      1,
    )
    collision.drawDynamic([body('player_0', 30, 40)], 1)
    expect(staticLabels.children).toHaveLength(0)
    collision.setVisible(true)
    expect(layer.visible).toBe(true)
    expect(staticLabels.children).toHaveLength(2)
    expect(dynamicLabels.children).toHaveLength(1)
    const rectLabel = staticLabels.children[0] as Text
    const treeLabel = staticLabels.children[1] as Text
    expect(rectLabel.text).toBe('crate')
    expect(rectLabel.position.x).toBe(10 + 2)
    expect(rectLabel.position.y).toBe(20 + 2)
    expect(treeLabel.text).toBe('tree')
    expect(treeLabel.position.x).toBe(30 + 8 + 2)
    expect(treeLabel.position.y).toBe(40 + 2)
    expect((dynamicLabels.children[0] as Text).text).toBe('player_0')
  })

  it('reuses label objects across draws, updating positions, and trims a shrinking list', () => {
    const { collision, createText, dynamicLabels } = mount()
    collision.setVisible(true)
    collision.drawDynamic(
      [body('player_0', 10, 10), body('player_1', 20, 20), body('player_2', 30, 30)],
      1,
    )
    const created = dynamicLabels.children.map((child) => child as Text)
    const createdLabelCalls = createText.mock.calls.length
    collision.drawDynamic(
      [body('player_0', 12, 14), body('player_1', 22, 24), body('player_2', 32, 34)],
      1,
    )
    const reused = dynamicLabels.children.map((child) => child as Text)
    for (let index = 0; index < reused.length; index += 1) {
      expect(reused[index]).toBe(created[index])
    }
    expect(createText.mock.calls.length).toBe(createdLabelCalls)
    expect(reused[0]?.position.x).toBe(12 + 8 + 2)
    expect(reused[0]?.position.y).toBe(14 + 2)
    collision.drawDynamic([body('player_0', 12, 14, 'renamed')], 1)
    expect(dynamicLabels.children).toHaveLength(1)
    const retained = dynamicLabels.children[0] as Text
    expect(retained).toBe(created[0])
    expect(retained.text).toBe('renamed')
  })
})
