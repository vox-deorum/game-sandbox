/**
 * The renderer contract. Each environment registers a frontend module that draws per-step states;
 * live play and replay share it by design, which gives the architecture two properties.
 *
 * First, **determinism**: `render(state)` must draw a frame that is a pure function of the passed
 * state (plus the mount-time header and metadata) with no dependence on what was rendered before, so
 * the live page, the replay player, and the scrubber are all the same call with a different state
 * source. The renderers draw on a retained PixiJS scene graph (display objects persist and are
 * mutated rather than a surface repainted each frame); that is an implementation detail beneath the
 * deterministic surface, because the reconciliation toward a given state is idempotent. See
 * `renderers/base/` and docs/contributors/rendering.md.
 *
 * Second, **the chrome split**: the renderer owns the game frame (the world plus the in-game UI such
 * as score, tick, and status that belongs inside the game) while the hosting page owns the session
 * chrome that must work for every environment (start/stop/pause, the status banner, the active-timeout
 * display, and later the feedback prompt). That split is what lets the live and replay hosts be built
 * once, for all future environments.
 */

import type { RecordingHeader, StepState } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'

/** Everything a renderer is handed once, at mount, before any state arrives. */
export interface RendererContext {
  /** The region the renderer owns and draws into. */
  container: HTMLElement
  /** Pace interval, slots, display name, and the rest of the environment's public metadata. */
  meta: EnvironmentMeta
  /** Environment, schema_version, and seed for the run being drawn. */
  header: RecordingHeader
  /** The slots this user controls; empty when spectating or replaying. */
  controlledSlots: readonly string[]
  /** Send a human action for a controlled slot; absent outside live human play. */
  sendAction?: (slot: string, action: unknown) => void
}

/** A mounted renderer: fed one state at a time, torn down once, and carrying its own shape. */
export interface RendererInstance {
  /**
   * The fixed logical coordinate space the renderer draws in, in logical pixels (Flappy Bird's is
   * 288 × 512). The renderer's code only ever speaks these coordinates and never sees a device pixel;
   * the PixiJS base class scales this space onto whatever real size the host gives it and keeps it
   * sharp on high-DPI displays. This replaces the single `targetCanvasSize` of the 2D era.
   */
  readonly internalSize: InternalSize
  /**
   * `internalSize.width / internalSize.height`, surfaced explicitly because it is the shape the host
   * reasons about: it sizes the stage element with a CSS `aspect-ratio` and places the decision log
   * beside a portrait canvas (`aspectRatio < 1`, a column is left free) or below a landscape one.
   * Keeping this on the renderer makes responsive layout a property the renderer owns rather than
   * something the host reverse-engineers from rendered pixels.
   */
  readonly aspectRatio: number
  render(state: StepState): void
  destroy(): void
}

/** The fixed logical coordinate space a renderer draws in; the base class scales it onto the host. */
export interface InternalSize {
  width: number
  height: number
}

/**
 * What an environment registers: the renderer's static identity. A renderer is one class — the
 * {@link PixiRenderer} subclass itself satisfies this, so there is no separate module object to keep
 * in sync. `mount` is a static factory that constructs the mounted instance (which carries the
 * `internalSize`/`aspectRatio` shape). The home-card thumbnail is not on the renderer at all: it is a
 * static SVG asset passed alongside the class to `registerRenderer`, so the cards never mount a
 * renderer to show its art.
 */
export interface Renderer {
  /** Construct and mount an instance into the host described by `ctx`. */
  mount(ctx: RendererContext): RendererInstance
}
