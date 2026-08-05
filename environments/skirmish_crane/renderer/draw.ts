/**
 * Small pieces the drawing modules share. The two factory types exist because building a sprite
 * needs the loaded texture map and building text needs the host's device resolution, both of which
 * live on the renderer class. Drawing modules take them as arguments rather than reaching back.
 */
import type { Container, Sprite, Text } from 'pixi.js'

import type { CraneAssetName } from './assets.js'

export const LATO = 'Lato, system-ui, sans-serif'
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Build a centered sprite from a loaded asset, or nothing while the artwork is still loading. */
export type SpriteFactory = (
  name: CraneAssetName,
  x: number,
  y: number,
  width: number,
  height: number,
) => Sprite | null

export type TextFactory = (
  value: string,
  size: number,
  fill: string,
  align: 'left' | 'center' | 'right',
  fontFamily?: string,
  stroke?: { color: string; width: number },
) => Text

/** Empty a layer and release what it held. Layers are rebuilt from the scene, never patched. */
export function clear(layer: Container): void {
  for (const child of layer.removeChildren()) child.destroy({ children: true })
}
