/**
 * How the host chrome reaches the mounted renderer's player identity: the player profiles it reports
 * (in-game names and teams) and its view-only highlight. `useRendererMount` provides it, so every page
 * that mounts a renderer gets it, and the chat panel, the decision log, and the replay thread inject it
 * through `PlayerTag` and the shared sender label. Outside a provider (an isolated component or a jsdom
 * test) the identity is empty: no profiles and a highlight that does nothing.
 */
import { type InjectionKey, inject, provide, type Ref, shallowRef } from 'vue'

import type { PlayerProfile } from '../renderers/types.js'

export interface PlayerIdentity {
  /** Player id → profile, from the renderer's `playerProfiles` for the latest drawn state. */
  profiles: Readonly<Ref<Readonly<Record<string, PlayerProfile>>>>
  /**
   * Point the renderer at one player on behalf of `source` (any object a tag owns), or withdraw that
   * source's request with `null`. See `sharedHighlight` for how several sources share the one highlight.
   */
  highlight(source: object, playerId: string | null): void
}

const PLAYER_IDENTITY: InjectionKey<PlayerIdentity> = Symbol('player-identity')

export function providePlayerIdentity(identity: PlayerIdentity): void {
  provide(PLAYER_IDENTITY, identity)
}

export function usePlayerIdentity(): PlayerIdentity {
  return inject(PLAYER_IDENTITY, () => ({ profiles: shallowRef({}), highlight: () => {} }), true)
}

/**
 * Share the renderer's single highlight among every tag on the page. The latest request wins, and
 * withdrawing one falls back to the newest request still standing, so leaving a hovered tag returns the
 * highlight to a focused one instead of clearing it. `forward` hears only actual changes.
 */
export function sharedHighlight(
  forward: (playerId: string | null) => void,
): PlayerIdentity['highlight'] {
  const requests: { source: object; playerId: string }[] = []
  let current: string | null = null
  return (source, playerId) => {
    const index = requests.findIndex((request) => request.source === source)
    if (index >= 0) requests.splice(index, 1)
    if (playerId !== null) requests.push({ source, playerId })
    const next = requests.at(-1)?.playerId ?? null
    if (next === current) return
    current = next
    forward(next)
  }
}
