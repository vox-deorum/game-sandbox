/** Retained world-only color grade, placed between art and emissive layers. */
import { Graphics } from 'pixi.js'

import { WORLD_SIZE } from './geometry.js'
import { phaseGradeFor } from './presentation.js'

export interface PhaseGradeSnapshot {
  phase: string
  color: string
  alpha: number
  visible: boolean
}

export class PhaseGradeLayer {
  readonly view = new Graphics()

  constructor() {
    this.view.blendMode = 'multiply'
  }

  update(phase: string): void {
    const grade = phaseGradeFor(phase)
    this.view.clear().rect(0, 0, WORLD_SIZE, WORLD_SIZE).fill(grade.color)
    this.view.label = `${phase}:${grade.color}`
    this.view.alpha = grade.alpha
    this.view.visible = grade.alpha > 0
  }

  /** Read the retained grade node after reconciliation. */
  snapshot(): PhaseGradeSnapshot {
    const [phase = '', color = ''] = this.view.label.split(':')
    return { phase, color, alpha: this.view.alpha, visible: this.view.visible }
  }
}
