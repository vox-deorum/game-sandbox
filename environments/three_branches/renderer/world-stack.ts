import { Container } from 'pixi.js'

import type { MapLayerView } from './map-layer.js'
import { createGradeFilter } from './post-effects.js'
import { HEARTHSIDE_STYLE } from './presentation.js'

/** The world containers and the two retained grades that decide which of them a filter covers. */
export interface WorldArtStack {
  /** The camera-transformed root the renderer masks and adds to the Pixi stage. */
  readonly root: Container
  /** Ungraded terrain, routes, and seams. */
  readonly natural: Container
  /** Generated art and architecture, always under the authored grade. */
  readonly authored: Container
  readonly scenery: Container
  readonly shadows: Container
  readonly props: Container
  /** The initial character container. A successful art load swaps a replacement into its slot. */
  readonly characters: Container
  /** The initial upper-wall container. A successful art load swaps a replacement into its slot. */
  readonly upper: Container
  readonly effects: Container
  readonly emissives: Container
  readonly highlight: Container
  readonly annotations: Container
  readonly collision: Container
  /** Attach or release the one retained night filter over terrain and authored art together. */
  setNightGrade(active: boolean): void
  /** Release both retained filters. Safe to call more than once. */
  destroy(): void
}

/**
 * Build the world scene graph in its drawn order. Natural terrain and the authored composite are
 * separate roots so the authored grade reaches generated art and architecture without touching the
 * terrain's daytime colour, and so the night grade can cover both at once by sitting on the shared
 * parent. Emissives, the prop highlight, annotations, and collision are outside both grades, which
 * makes "post-grade" a structural property rather than a rule someone has to remember.
 */
export function createWorldArtStack(mapView: MapLayerView): WorldArtStack {
  const natural = new Container({ label: 'world-natural' })
  const authored = new Container({ label: 'world-authored' })
  const scenery = new Container({ label: 'scenery' })
  const shadows = new Container({ label: 'prop-shadows' })
  const props = new Container({ label: 'props' })
  const characters = new Container({ label: 'characters' })
  const upper = new Container({ label: 'upper' })
  const effects = new Container({ label: 'effects' })
  const emissives = new Container({ label: 'emissives' })
  const highlight = new Container({ label: 'prop-highlight-layer' })
  const annotations = new Container({ label: 'annotations' })
  const collision = new Container({ label: 'collision' })
  const worldArt = new Container({ label: 'world-art' })
  const root = new Container({ label: 'world-root' })

  const authoredFilter = createGradeFilter(
    HEARTHSIDE_STYLE.postEffects.authoredGrade,
    HEARTHSIDE_STYLE.palette,
  )
  const nightFilter = createGradeFilter(
    HEARTHSIDE_STYLE.postEffects.nightGrade,
    HEARTHSIDE_STYLE.palette,
  )
  let night = false
  let destroyed = false

  natural.addChild(mapView.naturalView)
  authored.filters = [authoredFilter]
  authored.addChild(mapView.architectureView, scenery, shadows, props, characters, upper, effects)
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
      authored.filters = []
      worldArt.filters = []
      authoredFilter.destroy()
      nightFilter.destroy()
    },
  }
}
