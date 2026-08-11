/** Collision-truth overlay nodes, kept outside the graded art world. */
import { Container, Graphics, Text } from 'pixi.js'

import type { CollisionBody, DynamicCollisionScene, StaticCollisionScene } from './collision.js'
import type { Palette } from './scene.js'

interface CollisionNode {
  root: Container
  shape: Graphics
  label?: Text
  /** Present on a character: carries the heading so the label under it stays upright. */
  facing?: Container
}

/** Mount immutable geometry once, then reconcile only moving bodies and state labels. */
export class CollisionLayer {
  readonly view = new Container()
  readonly staticView = new Container()
  readonly dynamicView = new Container()
  private readonly buildings = new Map<string, CollisionNode>()
  private readonly waterBanks = new Map<string, CollisionNode>()
  private readonly confluences = new Map<string, CollisionNode>()
  private readonly boundaries = new Map<string, CollisionNode>()
  private readonly props = new Map<string, CollisionNode>()
  private readonly scenery = new Map<string, CollisionNode>()
  private readonly characters = new Map<string, CollisionNode>()
  private staticBuilds = 0
  private dynamicUpdates = 0
  private textResolution: number | null = null

  constructor(private readonly palette: Palette) {
    this.view.addChild(this.staticView, this.dynamicView)
    this.view.eventMode = 'none'
  }

  mountStatic(scene: StaticCollisionScene): void {
    if (this.staticBuilds > 0) return
    this.buildBuildings(scene)
    this.buildSegments(this.waterBanks, scene.waterBanks)
    this.buildCircles(this.confluences, scene.confluences)
    this.buildSegments(this.boundaries, scene.boundaries)
    this.buildProps(scene)
    this.buildCircles(this.scenery, scene.scenery)
    this.staticBuilds += 1
  }

  updateDynamic(scene: DynamicCollisionScene, visible: boolean, textResolution: number): void {
    this.setVisible(visible)
    if (!visible) return
    this.dynamicUpdates += 1
    for (const prop of scene.propLabels) {
      const label = this.props.get(prop.id)?.label
      if (label !== undefined && label.text !== prop.label) label.text = prop.label
    }
    this.reconcileCharacters(scene)
    this.setTextResolution(textResolution)
  }

  setVisible(visible: boolean): void {
    if (this.view.visible !== visible) this.view.visible = visible
  }

  setTextResolution(resolution: number): void {
    if (this.textResolution === resolution) return
    this.textResolution = resolution
    for (const map of [
      this.buildings,
      this.waterBanks,
      this.confluences,
      this.boundaries,
      this.props,
      this.scenery,
      this.characters,
    ]) {
      for (const node of map.values()) {
        if (node.label !== undefined) node.label.resolution = resolution
      }
    }
  }

  snapshot(): { staticBuilds: number; dynamicUpdates: number } {
    return { staticBuilds: this.staticBuilds, dynamicUpdates: this.dynamicUpdates }
  }

  destroy(): void {
    this.buildings.clear()
    this.waterBanks.clear()
    this.confluences.clear()
    this.boundaries.clear()
    this.props.clear()
    this.scenery.clear()
    this.characters.clear()
    this.view.destroy({ children: true })
  }

  private buildBuildings(scene: StaticCollisionScene): void {
    for (const building of scene.buildings) {
      const node = this.create(this.buildings, building.id, this.staticView)
      for (const wall of building.walls) {
        node.shape
          .moveTo(wall.start.x, wall.start.y)
          .lineTo(wall.end.x, wall.end.y)
          .stroke({ color: this.palette.collision, width: wall.radius * 2 })
      }
      const firstWall = building.walls[0]
      if (node.label !== undefined && firstWall !== undefined) {
        node.label.text = building.label
        node.label.position.set(firstWall.start.x, firstWall.start.y)
      }
    }
  }

  private buildSegments(
    map: Map<string, CollisionNode>,
    segments: StaticCollisionScene['waterBanks'],
  ): void {
    for (const segment of segments) {
      const node = this.create(map, segment.id, this.staticView)
      node.shape
        .moveTo(segment.start.x, segment.start.y)
        .lineTo(segment.end.x, segment.end.y)
        .stroke({ color: this.palette.collision, width: segment.radius * 2 })
      if (node.label !== undefined) {
        node.label.text = segment.label
        node.label.position.set(segment.start.x, segment.start.y)
      }
    }
  }

  private buildCircles(
    map: Map<string, CollisionNode>,
    circles: StaticCollisionScene['confluences'],
  ): void {
    for (const circle of circles) {
      const node = this.create(map, circle.id, this.staticView)
      node.shape
        .circle(circle.center.x, circle.center.y, circle.radius)
        .stroke({ color: this.palette.collision, width: 2 })
      if (node.label !== undefined) {
        node.label.text = circle.label
        node.label.position.set(circle.center.x, circle.center.y + circle.radius + 2)
      }
    }
  }

  private buildProps(scene: StaticCollisionScene): void {
    for (const prop of scene.props) {
      const node = this.create(this.props, prop.id, this.staticView)
      const [first, ...rest] = prop.corners
      if (first !== undefined) {
        node.shape.moveTo(first.x, first.y)
        for (const corner of rest) node.shape.lineTo(corner.x, corner.y)
        node.shape.closePath().stroke({ color: this.palette.collision, width: 2 })
        node.label?.position.set(first.x, first.y)
      }
    }
  }

  private reconcileCharacters(scene: DynamicCollisionScene): void {
    const present = new Set(scene.characters.map((character) => character.id))
    for (const [id, node] of this.characters) {
      if (!present.has(id)) {
        this.characters.delete(id)
        node.root.destroy({ children: true })
      }
    }
    for (const character of scene.characters) {
      if (!this.characters.has(character.id)) this.createCharacter(character)
    }
    for (const entry of scene.characterLabels) {
      const label = this.characters.get(entry.id)?.label
      if (label !== undefined && label.text !== entry.label) label.text = entry.label
    }
    this.applyMotion(scene.characters)
  }

  /**
   * Carry the retained bodies to one in-between position. Every body is the same circle and the same
   * heading tick, so an interpolated frame only moves and turns them.
   */
  applyMotion(characters: readonly CollisionBody[]): void {
    for (const character of characters) {
      const node = this.characters.get(character.id)
      if (node?.facing === undefined) continue
      node.root.position.set(character.position.x, character.position.y)
      node.facing.rotation = Math.atan2(
        character.headingEnd.y - character.position.y,
        character.headingEnd.x - character.position.x,
      )
    }
  }

  /** Draw one body at the origin, so the node's own transform is all a later frame has to move. */
  private createCharacter(character: CollisionBody): void {
    const node = this.create(this.characters, character.id, this.dynamicView)
    const facing = new Container()
    node.root.removeChild(node.shape)
    facing.addChild(node.shape)
    node.root.addChildAt(facing, 0)
    node.facing = facing
    const headingLength = Math.hypot(
      character.headingEnd.x - character.position.x,
      character.headingEnd.y - character.position.y,
    )
    node.shape
      .circle(0, 0, character.radius)
      .stroke({ color: this.palette.collision, width: 2 })
      .moveTo(0, 0)
      .lineTo(headingLength, 0)
      .stroke({ color: this.palette.collision, width: 2 })
    node.label?.position.set(0, character.radius + 2)
  }

  private create(map: Map<string, CollisionNode>, id: string, parent: Container): CollisionNode {
    const root = new Container()
    root.label = id
    const shape = new Graphics()
    const label = new Text({
      text: '',
      style: {
        fill: this.palette.collision,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 10,
      },
    })
    label.anchor.set(0, 0)
    if (this.textResolution !== null) label.resolution = this.textResolution
    root.addChild(shape, label)
    const node = { root, shape, label }
    map.set(id, node)
    parent.addChild(root)
    return node
  }
}
