import { Container } from 'pixi.js'
import { HEARTHSIDE_STYLE } from '../core/presentation.js'
import { createGradeFilter } from '../effects/post-effects.js'
import type { MapLayerView } from './map-layer.js'

/** The world containers and retained night grade that decide which layers the filter covers. */
export interface WorldArtStack {
  /** The camera-transformed root the renderer masks and adds to the Pixi stage. */
  readonly root: Container
  /** Ungraded terrain, routes, and seams. */
  readonly natural: Container
  /** Generated art and architecture. */
  readonly authored: Container
  readonly scenery: Container
  readonly shadows: Container
  readonly props: Container
  /** The initial character container. A successful art load swaps a replacement into its slot. */
  readonly characters: Container
  /** The initial upper-wall container. A successful art load swaps a replacement into its slot. */
  readonly upper: Container
  /** Retained semantic roof containers, inside the authored composite between upper walls and effects. */
  readonly roofs: Container
  readonly effects: Container
  readonly emissives: Container
  readonly highlight: Container
  readonly annotations: Container
  readonly collision: Container
  /** Attach or release the one retained night filter over terrain and authored art together. */
  setNightGrade(active: boolean): void
  /** Release the retained night filter. Safe to call more than once. */
  destroy(): void
}

/**
 * Build the world scene graph in its drawn order. Natural terrain and the authored composite stay
 * separate roots so the night grade can cover both at once from their shared parent. Emissives, the
 * prop highlight, annotations, and collision remain outside the night grade. This makes the filter
 * boundary structural rather than a rule someone has to remember.
 */
export function createWorldArtStack(mapView: MapLayerView): WorldArtStack {
  const natural = new Container({ label: 'world-natural' })
  const authored = new Container({ label: 'world-authored' })
  const scenery = new Container({ label: 'scenery' })
  const shadows = new Container({ label: 'prop-shadows' })
  const props = new Container({ label: 'props' })
  const characters = new Container({ label: 'characters' })
  const upper = new Container({ label: 'upper' })
  const roofs = new Container({ label: 'roofs' })
  const effects = new Container({ label: 'effects' })
  const emissives = new Container({ label: 'emissives' })
  const highlight = new Container({ label: 'prop-highlight-layer' })
  const annotations = new Container({ label: 'annotations' })
  const collision = new Container({ label: 'collision' })
  const worldArt = new Container({ label: 'world-art' })
  const root = new Container({ label: 'world-root' })

  const nightFilter = createGradeFilter(
    HEARTHSIDE_STYLE.postEffects.nightGrade,
    HEARTHSIDE_STYLE.palette,
  )
  let night = false
  let destroyed = false

  natural.addChild(mapView.naturalView)
  authored.addChild(
    mapView.architectureView,
    scenery,
    shadows,
    props,
    characters,
    upper,
    roofs,
    effects,
  )
  worldArt.addChild(natural, authored)
  root.addChild(worldArt, emissives, highlight, annotations, collision)

  return {
    root,
    natural,
    authored,
    scenery,
    shadows,
    props,
    characters,
    upper,
    roofs,
    effects,
    emissives,
    highlight,
    annotations,
    collision,
    setNightGrade(active) {
      if (active === night) return
      night = active
      // The instance is retained across the switch, so entering and leaving night costs an
      // attachment rather than a filter rebuild.
      worldArt.filters = active ? [nightFilter] : []
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      worldArt.filters = []
      nightFilter.destroy()
    },
  }
}
