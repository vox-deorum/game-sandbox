/** Collision-truth overlay nodes, kept outside the graded art world. */
import { Container, Graphics, Text } from 'pixi.js'

import type { CollisionScene } from './collision.js'
import type { Palette } from './scene.js'

interface CollisionNode {
  root: Container
  shape: Graphics
  label?: Text
}

interface CollisionSegment {
  id: string
  start: { x: number; y: number }
  end: { x: number; y: number }
  radius: number
  label: string
}

interface CollisionCircle {
  id: string
  center: { x: number; y: number }
  radius: number
  label: string
}

/** Reconcile collision shapes by their stable building, prop, and character ids. */
export class CollisionLayer {
  readonly view = new Container()
  private readonly buildings = new Map<string, CollisionNode>()
  private readonly waterBanks = new Map<string, CollisionNode>()
  private readonly confluences = new Map<string, CollisionNode>()
  private readonly boundaries = new Map<string, CollisionNode>()
  private readonly props = new Map<string, CollisionNode>()
  private readonly scenery = new Map<string, CollisionNode>()
  private readonly characters = new Map<string, CollisionNode>()

  constructor(private readonly palette: Palette) {
    this.view.eventMode = 'none'
  }

  update(scene: CollisionScene, visible: boolean, textResolution: number): void {
    this.view.visible = visible
    this.reconcileBuildings(scene)
    this.reconcileSegments(this.waterBanks, scene.waterBanks)
    this.reconcileCircles(this.confluences, scene.confluences)
    this.reconcileSegments(this.boundaries, scene.boundaries)
    this.reconcileProps(scene)
    this.reconcileCircles(this.scenery, scene.scenery)
    this.reconcileCharacters(scene)
    this.setTextResolution(textResolution)
  }

  setTextResolution(resolution: number): void {
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

  private reconcileBuildings(scene: CollisionScene): void {
    this.removeMissing(this.buildings, new Set(scene.buildings.map((building) => building.id)))
    for (const building of scene.buildings) {
      const node = this.buildings.get(building.id) ?? this.create(this.buildings, building.id, true)
      node.shape.clear()
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

  private reconcileSegments(map: Map<string, CollisionNode>, segments: CollisionSegment[]): void {
    this.removeMissing(map, new Set(segments.map((segment) => segment.id)))
    for (const segment of segments) {
      const node = map.get(segment.id) ?? this.create(map, segment.id, true)
      node.shape
        .clear()
        .moveTo(segment.start.x, segment.start.y)
        .lineTo(segment.end.x, segment.end.y)
        .stroke({ color: this.palette.collision, width: segment.radius * 2 })
      if (node.label !== undefined) {
        node.label.text = segment.label
        node.label.position.set(segment.start.x, segment.start.y)
      }
    }
  }

  private reconcileCircles(map: Map<string, CollisionNode>, circles: CollisionCircle[]): void {
    this.removeMissing(map, new Set(circles.map((circle) => circle.id)))
    for (const circle of circles) {
      const node = map.get(circle.id) ?? this.create(map, circle.id, true)
      node.shape
        .clear()
        .circle(circle.center.x, circle.center.y, circle.radius)
        .stroke({ color: this.palette.collision, width: 2 })
      if (node.label !== undefined) {
        node.label.text = circle.label
        node.label.position.set(circle.center.x, circle.center.y + circle.radius + 2)
      }
    }
  }

  private reconcileProps(scene: CollisionScene): void {
    this.removeMissing(this.props, new Set(scene.props.map((prop) => prop.id)))
    for (const prop of scene.props) {
      const node = this.props.get(prop.id) ?? this.create(this.props, prop.id, true)
      const [first, ...rest] = prop.corners
      node.shape.clear()
      if (first !== undefined) {
        node.shape.moveTo(first.x, first.y)
        for (const corner of rest) node.shape.lineTo(corner.x, corner.y)
        node.shape.closePath().stroke({ color: this.palette.collision, width: 2 })
        node.label?.position.set(first.x, first.y)
      }
      if (node.label !== undefined) node.label.text = prop.label
    }
  }

  private reconcileCharacters(scene: CollisionScene): void {
    this.removeMissing(this.characters, new Set(scene.characters.map((character) => character.id)))
    for (const character of scene.characters) {
      const node =
        this.characters.get(character.id) ?? this.create(this.characters, character.id, true)
      node.shape.clear()
      node.shape
        .circle(character.center.x, character.center.y, character.radius)
        .stroke({ color: this.palette.collision, width: 2 })
      node.shape
        .moveTo(character.center.x, character.center.y)
        .lineTo(character.headingEnd.x, character.headingEnd.y)
        .stroke({ color: this.palette.collision, width: 2 })
      if (node.label !== undefined) {
        node.label.text = `${character.id}: ${character.expression}`
        node.label.position.set(character.center.x, character.center.y + character.radius + 2)
      }
    }
  }

  private create(map: Map<string, CollisionNode>, id: string, labelled: boolean): CollisionNode {
    const root = new Container()
    const shape = new Graphics()
    const label = labelled
      ? new Text({
          text: '',
          style: {
            fill: this.palette.collision,
            fontFamily: 'system-ui, sans-serif',
            fontSize: 10,
          },
        })
      : undefined
    if (label !== undefined) label.anchor.set(0, 0)
    root.addChild(shape)
    if (label !== undefined) root.addChild(label)
    const node = { root, shape, label }
    map.set(id, node)
    this.view.addChild(root)
    return node
  }

  private removeMissing(map: Map<string, CollisionNode>, present: Set<string>): void {
    for (const [id, node] of map) {
      if (!present.has(id)) {
        map.delete(id)
        node.root.destroy({ children: true })
      }
    }
  }
}
