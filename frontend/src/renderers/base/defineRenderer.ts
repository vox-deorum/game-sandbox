/**
 * Builds a {@link RendererModule} from a {@link PixiRenderer} subclass and its thumbnail, so a
 * renderer is one declaration: `internalSize` and the derived `aspectRatio` come from the class's
 * static, `mount` constructs an instance, and `thumbnail` is passed in. See
 * docs/contributors/rendering.md ("Adding a renderer").
 */

import type { RendererModule } from '../types.js'
import type { PixiRendererClass } from './PixiRenderer.js'

export interface DefineRendererOptions {
  /** Static asset URL for the home card. */
  thumbnail: string
}

export function defineRenderer(
  RendererClass: PixiRendererClass,
  options: DefineRendererOptions,
): RendererModule {
  const { internalSize } = RendererClass
  return {
    internalSize,
    aspectRatio: internalSize.width / internalSize.height,
    thumbnail: options.thumbnail,
    mount: (ctx) => new RendererClass(ctx),
  }
}
