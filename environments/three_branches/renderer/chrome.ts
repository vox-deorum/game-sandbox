/** Screen-fixed status strip and the viewer-only collision toggle. */
import { Container, Graphics, Rectangle, Text } from 'pixi.js'

import type { DynamicScene } from './scene.js'

/** Logical height reserved above the camera viewport for the status controls. */
export const CHROME_HEIGHT = 54
/** The collision button's logical rectangle. The browser journey presses its center. */
export const TOGGLE = { x: 958, y: 10, width: 224, height: 34 }

/** Fixed game chrome. The collision button changes viewer state only. */
export class VillageChrome {
  readonly view = new Container()
  private readonly strip = new Graphics()
  private readonly toggle = new Graphics()
  private readonly tick = textNode()
  private readonly phase = textNode()
  private readonly bell = textNode()
  private readonly terminal = textNode(18)

  constructor(private readonly onToggle: () => void) {
    this.strip.rect(0, 0, 1200, CHROME_HEIGHT).fill({ color: '#172531', alpha: 0.9 })
    this.toggle.eventMode = 'static'
    this.toggle.cursor = 'pointer'
    this.toggle.accessible = true
    this.toggle.accessibleType = 'button'
    this.toggle.accessibleTitle = 'Toggle collision overlay'
    this.toggle.hitArea = new Rectangle(TOGGLE.x, TOGGLE.y, TOGGLE.width, TOGGLE.height)
    this.toggle.on('pointertap', (event) => {
      event.stopPropagation()
      this.onToggle()
    })
    this.tick.position.set(18, 17)
    this.phase.position.set(245, 17)
    this.bell.position.set(485, 17)
    this.terminal.anchor.set(0.5, 0)
    this.terminal.position.set(600, 66)
    this.view.addChild(this.strip, this.tick, this.phase, this.bell, this.terminal, this.toggle)
  }

  update(chrome: DynamicScene['chrome'], collision: boolean, textResolution: number): void {
    this.tick.text = chrome.tick
    this.phase.text = chrome.phase
    this.bell.text = chrome.bell
    this.terminal.text = chrome.terminal ?? ''
    this.terminal.visible = chrome.terminal !== null
    this.toggle.clear()
    this.toggle
      .roundRect(TOGGLE.x, TOGGLE.y, TOGGLE.width, TOGGLE.height, 6)
      .fill(collision ? '#b73838' : '#375466')
      .stroke({ color: '#ffffff', width: 1 })
    const label = collision ? 'Collision: on' : 'Collision: off'
    // The label is drawn in Graphics-independent text so its pointer hit area stays exactly the
    // rectangle above and every click remains viewer-only.
    this.ensureToggleLabel().text = label
    this.setTextResolution(textResolution)
  }

  setTextResolution(resolution: number): void {
    this.tick.resolution = resolution
    this.phase.resolution = resolution
    this.bell.resolution = resolution
    this.terminal.resolution = resolution
    this.ensureToggleLabel().resolution = resolution
  }

  destroy(): void {
    this.view.destroy({ children: true })
  }

  private ensureToggleLabel(): Text {
    const existing = this.toggle.children.find((child): child is Text => child instanceof Text)
    if (existing !== undefined) return existing
    const label = textNode(13)
    label.anchor.set(0.5, 0.5)
    label.position.set(TOGGLE.x + TOGGLE.width / 2, TOGGLE.y + TOGGLE.height / 2)
    this.toggle.addChild(label)
    return label
  }
}

function textNode(size = 14): Text {
  return new Text({
    text: '',
    style: { fill: '#ffffff', fontFamily: 'system-ui, sans-serif', fontSize: size },
  })
}
