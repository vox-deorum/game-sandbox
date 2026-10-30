import { Container } from 'pixi.js'
import {
  createGradeFilter,
  type DayLight,
  gradeMatrix,
  isIdentityMatrix,
} from '../effects/post-effects.js'
import type { MapLayerView } from './map-layer.js'

/** The world containers and retained day grade that decide which layers the filter covers. */
export interface WorldArtStack {
  /** The camera-transformed root the renderer masks and adds to the Pixi stage. */
  readonly root: Container
  readonly scenery: Container
  readonly outlines: Container
  readonly props: Container
  /** The initial character container. A successful art load swaps a replacement into its slot. */
  readonly characters: Container
  /** The initial upper-wall container. A successful art load swaps a replacement into its slot. */
  readonly upper: Container
  /** Retained semantic roof containers, inside the authored composite between upper walls and effects. */
  readonly roofs: Container
  readonly effects: Container
  /** White cranes flying above the authored village, inside the grade. */
  readonly cranes: Container
  /** Drifting cloud shadows over everything else in the world art, inside the grade. */
  readonly clouds: Container
  readonly emissives: Container
  readonly highlight: Container
  readonly annotations: Container
  readonly collision: Container
  /**
   * Grade terrain and authored art together with the day light. The one retained filter is
   * detached while the grade is the identity, so midday and the off phase cost no pass.
   */
  setDayLight(light: DayLight): void
  /** Release the retained grade filter. Safe to call more than once. */
  destroy(): void
}

/**
 * Build the world scene graph in its drawn order. Natural terrain, the authored composite, the
 * cranes, and the cloud shadows share one parent so the day grade covers them all at once.
 * Emissives, the prop highlight, annotations, and collision remain outside the grade, so light
 * pools stay warm at night and overlays never shift colour. This makes the filter boundary
 * structural rather than a rule someone has to remember.
 */
export function createWorldArtStack(mapView: MapLayerView): WorldArtStack {
  const natural = new Container({ label: 'world-natural' })
  const authored = new Container({ label: 'world-authored' })
  const scenery = new Container({ label: 'scenery' })
  const outlines = new Container({ label: 'prop-outlines' })
  const props = new Container({ label: 'props' })
  const characters = new Container({ label: 'characters' })
  const upper = new Container({ label: 'upper' })
  const roofs = new Container({ label: 'roofs' })
  const effects = new Container({ label: 'effects' })
  const cranes = new Container({ label: 'cranes' })
  const clouds = new Container({ label: 'clouds' })
  const emissives = new Container({ label: 'emissives' })
  const highlight = new Container({ label: 'prop-highlight-layer' })
  const annotations = new Container({ label: 'annotations' })
  const collision = new Container({ label: 'collision' })
  const worldArt = new Container({ label: 'world-art' })
  // The world root and the static terrain views are Pixi render groups. Camera moves then change
  // one GPU transform instead of re-packing every batched vertex, and a redraw in a dynamic layer
  // rebuilds only its own draw instructions rather than re-batching the whole terrain.
  const root = new Container({ label: 'world-root', isRenderGroup: true })

  const gradeFilter = createGradeFilter()
  let graded = false
  let destroyed = false

  natural.addChild(mapView.naturalView)
  authored.addChild(
    mapView.architectureView,
    outlines,
    scenery,
    props,
    characters,
    upper,
    roofs,
    effects,
  )
  worldArt.addChild(natural, authored, cranes, clouds)
  root.addChild(worldArt, emissives, highlight, annotations, collision)

  return {
    root,
    scenery,
    outlines,
    props,
    characters,
    upper,
    roofs,
    effects,
    cranes,
    clouds,
    emissives,
    highlight,
    annotations,
    collision,
    setDayLight(light) {
      const matrix = gradeMatrix(light)
      const active = !isIdentityMatrix(matrix)
      if (active) gradeFilter.matrix = matrix
      if (active === graded) return
      graded = active
      // The instance is retained across the switch, so leaving and re-entering midday costs an
      // attachment rather than a filter rebuild.
      worldArt.filters = active ? [gradeFilter] : []
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      worldArt.filters = []
      gradeFilter.destroy()
    },
  }
}
