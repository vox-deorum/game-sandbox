import { describe, expect, it } from 'vitest'
import type { StaticScene, VillageStatic } from '../core/types.js'
import { staticCollision } from '../map/collision.js'
import { buildStaticScene, pointToWorld } from '../map/scene.js'
import { lineClear, propUseShapes, selectUseTarget } from './use-preview.js'

/**
 * A small hand-built village on a 10 by 6 grid of one-metre cells. Rows are recorded south first,
 * so rows[0] is the southern edge. Props are declared in canonical order, which is what the tie
 * break reads.
 */
const OPEN_ROW = 'g'.repeat(10)

function sceneWith(
  props: VillageStatic['props'],
  rows: readonly string[] = Array.from({ length: 6 }, () => OPEN_ROW),
): StaticScene {
  return buildStaticScene({
    size: { cellsX: 10, cellsY: 6, cellSize: 1 },
    ground: rows,
    buildings: [],
    props,
    scenery: [{ type: 'pine', cell: { x: 9, y: 5 }, scale: 1 }],
    spawn: { x: 5, y: 3 },
  })
}

function lantern(id: string, x: number, y: number): VillageStatic['props'][number] {
  return { id, type: 'lantern', cell: { x, y }, facing: 'north' }
}

/** Run the selection from a metre-space visitor position, as the landed overlay reports it. */
function select(scene: StaticScene, x: number, y: number): string | null {
  const shapes = propUseShapes(scene, staticCollision(scene))
  return selectUseTarget(scene, shapes, pointToWorld(scene.village, x, y))
}

describe('Three Branches use preview', () => {
  it('keeps only interactive props, in canonical prop order', () => {
    const scene = sceneWith([lantern('lantern_0', 2, 2), lantern('lantern_1', 5, 2)])
    const shapes = propUseShapes(scene, staticCollision(scene))
    expect(shapes.map((shape) => shape.id)).toEqual(['lantern_0', 'lantern_1'])
  })

  it('selects the nearest prop by its nearest collision point', () => {
    const scene = sceneWith([lantern('lantern_0', 2, 2), lantern('lantern_1', 5, 2)])
    expect(select(scene, 4.2, 2.5)).toBe('lantern_1')
    expect(select(scene, 3.8, 2.5)).toBe('lantern_0')
  })

  it('includes the exact reach boundary and excludes anything past it', () => {
    // The lantern circle's nearest point sits at x = 3, so reach runs out at x = 4.5.
    const scene = sceneWith([lantern('lantern_0', 2, 2)])
    expect(select(scene, 4.5, 2.5)).toBe('lantern_0')
    expect(select(scene, 4.6, 2.5)).toBeNull()
  })

  it('drops a prop behind a wall cell that an open village would select', () => {
    const props = [lantern('lantern_0', 2, 2)]
    const open = sceneWith(props)
    expect(select(open, 4.4, 2.5)).toBe('lantern_0')
    const walled = sceneWith(props, [
      OPEN_ROW,
      OPEN_ROW,
      'gggxgggggg',
      OPEN_ROW,
      OPEN_ROW,
      OPEN_ROW,
    ])
    expect(select(walled, 4.4, 2.5)).toBeNull()
  })

  it('breaks an exact distance tie by canonical prop order', () => {
    const scene = sceneWith([lantern('lantern_0', 2, 2), lantern('lantern_1', 5, 2)])
    // Both nearest points sit exactly one metre away, on either side of the visitor.
    expect(select(scene, 4.0, 2.5)).toBe('lantern_0')
  })

  it('answers null when no prop is in reach', () => {
    const scene = sceneWith([lantern('lantern_0', 2, 2)])
    expect(select(scene, 9.0, 5.0)).toBeNull()
  })

  it('measures a box prop to its nearest corner', () => {
    const scene = sceneWith([
      { id: 'stall_0', type: 'stall', cell: { x: 1, y: 1 }, facing: 'north' },
    ])
    // The stall covers metres 1 to 3 on both axes, so its corner (3, 3) is the nearest point.
    expect(select(scene, 4.0, 4.0)).toBe('stall_0')
    expect(select(scene, 4.1, 4.1)).toBeNull()
  })

  describe('lineClear', () => {
    it('passes an open straight line and blocks one crossing a wall cell', () => {
      const open = sceneWith([])
      const walled = sceneWith([], [OPEN_ROW, OPEN_ROW, 'gggxgggggg', OPEN_ROW, OPEN_ROW, OPEN_ROW])
      const start = pointToWorld(open.village, 4.4, 2.5)
      const end = pointToWorld(open.village, 3.0, 2.5)
      expect(lineClear(open, start, end)).toBe(true)
      expect(lineClear(walled, start, end)).toBe(false)
    })

    it('cannot see through a diagonal wall corner', () => {
      // The diagonal from (1.5, 1.5) to (3.5, 3.5) crosses the corner at (2, 2), whose side cell
      // (2, 1) is a wall. The engine's supercover checks both side cells, and so does the mirror.
      const walled = sceneWith([], [OPEN_ROW, 'ggxggggggg', OPEN_ROW, OPEN_ROW, OPEN_ROW, OPEN_ROW])
      const start = pointToWorld(walled.village, 1.5, 1.5)
      const end = pointToWorld(walled.village, 3.5, 3.5)
      expect(lineClear(walled, start, end)).toBe(false)
      const open = sceneWith([])
      expect(lineClear(open, start, end)).toBe(true)
    })

    it('reads an out-of-grid endpoint as clear, as the engine supercover does', () => {
      const scene = sceneWith([])
      const inside = pointToWorld(scene.village, 5, 3)
      expect(lineClear(scene, inside, { x: -50, y: -50 })).toBe(true)
    })
  })
})
