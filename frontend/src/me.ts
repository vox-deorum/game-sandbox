/**
 * The app-shell identity provider. The shell fetches `GET /api/me` once at startup so the header can
 * show the signed-in user and every page can learn what the user may do, without each page refetching.
 * Components read it through {@link useMe} and derive capabilities with {@link canParticipate} and
 * {@link isAdmin}.
 *
 * The one `/api/me` fetch is the single identity source: a sign-in or sign-out is a full-page
 * navigation (see `LoginPage.vue` and `AccountMenu.vue`), which re-runs this fetch, rather than a
 * reactive session propagated through a second source.
 */
import { defineComponent, type InjectionKey, inject, provide, reactive } from 'vue'

import { getMe, type Me } from './api/client.js'

/** True when the user may start sessions, submit, and rate: status `normal` or `admin` (never null). */
export function canParticipate(me: Me | null): boolean {
  const status = me?.user?.status
  return status === 'normal' || status === 'admin'
}

/** True when the user may see and drive the operator admin console: status `admin`. */
export function isAdmin(me: Me | null): boolean {
  return me?.user?.status === 'admin'
}

/** The signed-in user's id, or `null` for an anonymous visitor (or an unresolved fetch). */
export function userId(me: Me | null): string | null {
  return me?.user?.id ?? null
}

/**
 * The error shown when a still-pending account tries to start a session (the backend answers the
 * start with a `not_active` 403). Shared by the hub and the watch picker so the two cannot drift.
 */
export const PENDING_START_MESSAGE =
  "Your account is awaiting approval, so you can't start sessions yet."

export interface MeState {
  me: Me | null
  loading: boolean
  error: boolean
  /**
   * Resolves once the single `/api/me` fetch has settled (success or failure). Pages that must know
   * the identity before acting await this instead of polling `loading`, which removes a latent race
   * rather than relocating it (see plans/stage-04.5/page-restructure.md).
   */
  whenSettled(): Promise<void>
}

const ME_KEY: InjectionKey<MeState> = Symbol('me')

/** Build the reactive me-state and kick off the single `/api/me` fetch that fills it in. */
export function createMeState(): MeState {
  let settle: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    settle = resolve
  })
  const state = reactive<MeState>({
    me: null,
    loading: true,
    error: false,
    whenSettled: () => settled,
  })
  getMe()
    .then(
      (me) => {
        state.me = me
        state.loading = false
        state.error = false
      },
      () => {
        state.me = null
        state.loading = false
        state.error = true
      },
    )
    .finally(() => settle())
  return state
}

/**
 * Provider component: fetches `/api/me` once and provides the shared, reactive state to every
 * descendant. The app wraps the shell in this; tests wrap the page under test in it so the same one
 * fetch backs the header and the pages.
 */
export const MeProvider = defineComponent({
  name: 'MeProvider',
  setup(_props, { slots }) {
    provide(ME_KEY, createMeState())
    return () => slots.default?.()
  },
})

/** The resolved session identity and status, plus its load state, for the nearest provider. */
export function useMe(): MeState {
  return (
    inject(ME_KEY) ??
    reactive<MeState>({
      me: null,
      loading: false,
      error: true,
      whenSettled: () => Promise.resolve(),
    })
  )
}
