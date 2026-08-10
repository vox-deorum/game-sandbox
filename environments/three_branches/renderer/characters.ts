/** Retained placeholder villagers and visitor. */
import { Container, Graphics, Text } from 'pixi.js'

import type { DynamicScene, Palette } from './scene.js'

interface CharacterNode {
  root: Container
  shape: Graphics
  label: Text
}

/** Reconcile the cast by stable character id. */
export class CharactersLayer {
  readonly view = new Container()
  private readonly nodes = new Map<string, CharacterNode>()

  constructor(private readonly palette: Palette) {}

  update(dynamic: DynamicScene, textResolution: number): void {
    const visible = new Set(dynamic.characters.map((character) => character.id))
    for (const [id, node] of this.nodes) {
      if (!visible.has(id)) {
        this.nodes.delete(id)
        node.root.destroy({ children: true })
      }
    }
    for (const character of dynamic.characters) {
      const node = this.nodes.get(character.id) ?? this.create(character.id)
      node.root.position.set(character.position.x, character.position.y)
      node.shape.clear()
      node.shape
        .circle(0, 0, character.radius)
        .fill(this.palette.character)
        .stroke({ color: '#ffffff', width: 1.5 })
      node.shape
        .moveTo(0, 0)
        .lineTo(
          character.headingEnd.x - character.position.x,
          character.headingEnd.y - character.position.y,
        )
        .stroke({ color: '#ffffff', width: 2 })
      node.label.text = `${character.id}\n${character.expressionLabel}`
      node.label.position.set(0, character.radius + 3)
      node.label.resolution = textResolution
    }
  }

  setTextResolution(resolution: number): void {
    for (const node of this.nodes.values()) node.label.resolution = resolution
  }

  destroy(): void {
    this.nodes.clear()
    this.view.destroy({ children: true })
  }

  private create(id: string): CharacterNode {
    const root = new Container()
    const shape = new Graphics()
    const label = new Text({
      text: id,
      style: {
        fill: '#ffffff',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 11,
        align: 'center',
      },
    })
    label.anchor.set(0.5, 0)
    root.addChild(shape, label)
    this.nodes.set(id, { root, shape, label })
    this.view.addChild(root)
    return { root, shape, label }
  }
}
