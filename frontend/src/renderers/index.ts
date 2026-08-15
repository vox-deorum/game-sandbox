/**
 * Renderer registration barrel. Importing this once (from `main.ts`) is what pulls every
 * environment's renderer in so it can register itself with the registry. Renderer definitions live
 * beside their environment packages and are registered by this eager glob.
 */
import { registerRenderer } from './registry.js'
import type { RendererDefinition } from './types.js'

const modules = import.meta.glob<{ default: RendererDefinition }>(
  '../../../environments/*/renderer/index.ts',
  { eager: true },
)

const rendererKeys = new Set<string>()
for (const [path, module] of Object.entries(modules)) {
  const definition = module.default
  if (
    !definition?.key ||
    typeof definition.renderer?.mount !== 'function' ||
    !definition.thumbnail
  ) {
    throw new Error(`Invalid renderer definition from ${path}`)
  }
  if (rendererKeys.has(definition.key)) {
    throw new Error(`Duplicate renderer key '${definition.key}' from ${path}`)
  }
  rendererKeys.add(definition.key)
  registerRenderer(definition.key, definition.renderer, definition.thumbnail)
}
