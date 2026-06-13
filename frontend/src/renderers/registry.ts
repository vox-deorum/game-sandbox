/**
 * The renderer registry: maps an environment's metadata `renderer` key (Flappy Bird's is
 * `"flappy-bird"`) to its renderer class and home-card thumbnail. The barrel registers each one on
 * import; the host pages look renderers up by key and the home cards look thumbnails up by key.
 *
 * The home-card thumbnail the spec asks for is not in the environment metadata; it is the SVG asset
 * registered alongside the class, with a generic placeholder for an environment whose renderer is not
 * registered yet. So adding an environment's visuals is one frontend class plus its thumbnail and zero
 * metadata changes.
 */

// A neutral placeholder card image for environments whose renderer is not registered yet.
import placeholderThumbnail from './placeholder.svg'
import type { Renderer } from './types.js'

/** A registered renderer and the home-card thumbnail (an SVG asset URL) registered alongside it. */
interface RegistryEntry {
  renderer: Renderer
  thumbnail: string
}

const registry = new Map<string, RegistryEntry>()

/**
 * Register a renderer and its home-card thumbnail under its metadata `renderer` key. The thumbnail is
 * a static SVG asset URL (imported by the barrel), kept off the renderer so the cards never mount one
 * to show its art. The last registration for a key wins.
 */
export function registerRenderer(key: string, renderer: Renderer, thumbnail: string): void {
  registry.set(key, { renderer, thumbnail })
}

/** The renderer registered for a key, or `undefined` when none is registered yet. */
export function getRenderer(key: string): Renderer | undefined {
  return registry.get(key)?.renderer
}

/** The thumbnail for a renderer key, falling back to the placeholder when unregistered. */
export function thumbnailFor(key: string): string {
  return registry.get(key)?.thumbnail ?? placeholderThumbnail
}
