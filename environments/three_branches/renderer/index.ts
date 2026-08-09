/**
 * The temporary renderer contract for Days at Three Branches.
 *
 * The finished village renderer will decode the environment overlay. Until that surface arrives,
 * this renderer keeps the production registration contract intact without interpreting state.
 */
import type { StepState } from '@game-sandbox/schema'
import { PixiRenderer } from '@renderers/base/PixiRenderer.js'
import type { RendererDefinition } from '@renderers/types.js'
import type { Container } from 'pixi.js'

import thumbnail from './thumbnail.svg'

export class ThreeBranchesRenderer extends PixiRenderer {
  readonly internalSize = { width: 1000, height: 700 } as const

  protected setup(_root: Container): void {}

  protected update(_state: StepState): void {}
}

const definition = {
  key: 'three-branches-village',
  renderer: ThreeBranchesRenderer,
  thumbnail,
} satisfies RendererDefinition

export default definition
