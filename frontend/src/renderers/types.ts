/**
 * The renderer contract. Each environment registers a frontend module that draws per-step states;
 * live play and replay share it by design, which gives the architecture two properties.
 *
 * First, **purity**: `render(state)` must draw entirely from the passed state (plus the mount-time
 * header and metadata) with no accumulated history, so the live page, the replay player, and the
 * scrubber are all the same call with a different state source.
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

/** A mounted renderer: fed one state at a time, torn down once. */
export interface RendererInstance {
  render(state: StepState): void
  destroy(): void
}

/** The module an environment registers: how to mount it, and the home-card thumbnail. */
export interface RendererModule {
  mount(ctx: RendererContext): RendererInstance
  /** Static asset URL for the home cards. */
  thumbnail: string
}
