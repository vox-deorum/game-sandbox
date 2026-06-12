/**
 * The renderer registry: maps an environment's metadata `renderer` key (Flappy Bird's is
 * `"flappy-bird"`) to its module. Each renderer module registers itself here on import; the host
 * pages and the home cards look modules up by key.
 *
 * The home-card thumbnail the spec asks for is not in the environment metadata; it comes from the
 * registered module's `thumbnail`, with a generic placeholder for an environment whose renderer is
 * not registered yet. So adding an environment's visuals is one frontend module and zero metadata
 * changes.
 */
import type { RendererModule } from './types.js'

const registry = new Map<string, RendererModule>()

/** Register a module under its metadata `renderer` key. The last registration for a key wins. */
export function registerRenderer(key: string, module: RendererModule): void {
  registry.set(key, module)
}

/** The module registered for a key, or `undefined` when no renderer is registered yet. */
export function getRenderer(key: string): RendererModule | undefined {
  return registry.get(key)
}

// A neutral placeholder card image for environments whose renderer module is not registered yet.
const PLACEHOLDER_THUMBNAIL =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
      '<rect width="320" height="180" fill="#1f2933"/>' +
      '<text x="160" y="96" fill="#9aa5b1" font-family="sans-serif" font-size="18" ' +
      'text-anchor="middle">No preview yet</text></svg>',
  )

/** The thumbnail for a renderer key, falling back to the placeholder when unregistered. */
export function thumbnailFor(key: string): string {
  return registry.get(key)?.thumbnail ?? PLACEHOLDER_THUMBNAIL
}
