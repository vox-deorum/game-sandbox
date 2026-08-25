/**
 * The app-shell identity provider. The shell fetches `GET /api/me` at startup so the header can show
 * the signed-in user and every page can learn what the user may do, without each page refetching.
 * Components read it through {@link useMe} and derive capabilities with {@link canParticipate} and
 * {@link isAdmin}. An in-place account change may explicitly refresh this same shared identity.
 *
 * `/api/me` remains the single identity source: refreshes replace its value in place, while sign-in
 * and sign-out use a full-page navigation (see `LoginPage.vue` and `AccountMenu.vue`) that creates a
 * fresh provider rather than propagating a second reactive session source.
 */
import { defineComponent, type InjectionKey, inject, provide, reactive } from 'vue'

import { getMe, type Me } from './api/client.js'

/** True when the user may start sessions, submit, and rate: status `normal` or `admin` (never null). */
export function canParticipate(me: Me | null): boolean {
  const status = me?.user?.status
  return status === 'normal' || status === 'admin'
}

/** True when the user may start and stop sessions (but not submit or rate): `guest`, `normal`, `admin`. */
export function canPlay(me: Me | null): boolean {
  const status = me?.user?.status
  return status === 'guest' || status === 'normal' || status === 'admin'
}

/**
 * True when the user must not see real user names anywhere: a guest, or an anonymous visitor. An
 * unresolved identity (no `/api/me` answer yet) reads as anonymous, so name masking fails closed.
 */
export function hidesNames(me: Me | null): boolean {
  return me?.user == null || me.user.status === 'guest'
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
  /** Re-fetch `/api/me` after an in-place identity change, such as disconnecting GitHub. */
  refresh(): Promise<void>
  /**
   * Resolves once the initial `/api/me` fetch has settled (success or failure). Pages that must know
   * the identity before acting await this instead of polling `loading`, which removes a latent race
   * rather than relocating it (see plans/stage-04.5/page-restructure.md).
   */
  whenSettled(): Promise<void>
}

const ME_KEY: InjectionKey<MeState> = Symbol('me')

/** Build the reactive me-state and kick off the initial `/api/me` fetch that fills it in. */
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
    refresh: async () => {},
  })
  let initialStarted = false
  state.refresh = async (): Promise<void> => {
    const isInitial = !initialStarted
    initialStarted = true
    try {
      state.me = await getMe()
      state.error = false
    } catch {
      if (isInitial) {
        state.me = null
      }
      state.error = true
    } finally {
      if (isInitial) {
        state.loading = false
        settle()
      }
    }
  }
  void state.refresh()
  return state
}

/**
 * Provider component: starts the shared `/api/me` identity state and provides it to every descendant.
 * The app wraps the shell in this; tests wrap the page under test in it so the same initial fetch and
 * any explicit refresh back the header and the pages.
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
      refresh: () => Promise.resolve(),
      whenSettled: () => Promise.resolve(),
    })
  )
}
