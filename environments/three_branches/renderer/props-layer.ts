/** Retained placeholder nodes for village props. */
import { Container, Graphics, Text } from 'pixi.js'

import type { DynamicScene, Palette, StaticScene } from './scene.js'

interface PropNode {
  root: Container
  shape: Graphics
  label: Text
}

/** Reconcile every prop by its stable overlay id. */
export class PropsLayer {
  readonly view = new Container()
  private readonly nodes = new Map<string, PropNode>()
  private readonly statics = new Map<string, StaticScene['props'][number]>()

  constructor(
    staticScene: StaticScene,
    private readonly palette: Palette,
  ) {
    for (const prop of staticScene.props) this.statics.set(prop.id, prop)
  }

  update(dynamic: DynamicScene, textResolution: number): void {
    const visible = new Set(dynamic.props.map((prop) => prop.id))
    for (const [id, node] of this.nodes) {
      if (!visible.has(id)) {
        this.nodes.delete(id)
        node.root.destroy({ children: true })
      }
    }
    for (const dynamicProp of dynamic.props) {
      const staticProp = this.statics.get(dynamicProp.id)
      if (staticProp === undefined) continue
      const node = this.nodes.get(dynamicProp.id) ?? this.create(dynamicProp.id, staticProp)
      node.label.text = `${staticProp.title}: ${dynamicProp.stateLabel}`
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

  private create(id: string, prop: StaticScene['props'][number]): PropNode {
    const root = new Container()
    const shape = new Graphics()
    const label = new Text({
      text: '',
      style: { fill: '#ffffff', fontFamily: 'system-ui, sans-serif', fontSize: 10 },
    })
    label.anchor.set(0.5, 0)
    shape
      .rect(-prop.width / 2, -prop.depth / 2, prop.width, prop.depth)
      .fill(this.palette.prop)
      .stroke({ color: '#58391e', width: 2 })
    root.position.set(prop.position.x, prop.position.y)
    root.rotation = (prop.rotation * Math.PI) / 180
    label.position.set(0, prop.depth / 2 + 3)
    root.addChild(shape, label)
    this.nodes.set(id, { root, shape, label })
    this.view.addChild(root)
    return { root, shape, label }
  }
}
