/**
 * The renderer registry: maps an environment's metadata `renderer` key (Flappy Bird's is
 * `"flappy-bird"`) to its renderer class and home-card thumbnail. The barrel registers each one on
 * import; the host pages look renderers up by key and the home cards look thumbnails up by key.
 *
 * The home-card thumbnail the spec asks for is not in the environment metadata; it is the image asset
 * registered alongside the class, with a generic placeholder for an environment whose renderer is not
 * registered yet. So adding an environment's visuals is one frontend class plus its thumbnail and zero
 * metadata changes.
 */

// A neutral placeholder card image for environments whose renderer is not registered yet.
import placeholderThumbnail from './placeholder.svg'
import type { Renderer, RendererDefinition } from './types.js'

/** A registered renderer and the home-card thumbnail asset URL registered alongside it. */
interface RegistryEntry {
  renderer: Renderer
  thumbnail: string
}

const registry = new Map<string, RegistryEntry>()

/**
 * Register a renderer and its home-card thumbnail under its metadata `renderer` key. The thumbnail is
 * a static image asset URL (imported by the barrel), kept off the renderer so the cards never mount one
 * to show its art. The last registration for a key wins.
 */
export function registerRenderer(key: string, renderer: Renderer, thumbnail: string): void {
  registry.set(key, { renderer, thumbnail })
}

/**
 * Register every renderer module in a glob keyed by module path. Each module must export a valid
 * definition, and two modules may not claim the same key.
 */
export function registerRendererModules(
  modules: Record<string, { default: RendererDefinition }>,
): void {
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
}

/** The renderer registered for a key, or `undefined` when none is registered yet. */
export function getRenderer(key: string): Renderer | undefined {
  return registry.get(key)?.renderer
}

/** The thumbnail for a renderer key, falling back to the placeholder when unregistered. */
export function thumbnailFor(key: string): string {
  return registry.get(key)?.thumbnail ?? placeholderThumbnail
}
