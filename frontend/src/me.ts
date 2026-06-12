/**
 * The app-shell identity provider. The shell fetches `GET /api/me` once at startup so the header can
 * show "signed in as ⟨user⟩" and every page can learn whether the user may start sessions, without
 * each page refetching. Components read it through {@link useMe}.
 *
 * When OAuth lands this is the seam it drops into: the provider keeps the same shape, only its source
 * changes from the mock auto-logon to the real session.
 */
import { defineComponent, type InjectionKey, inject, provide, reactive } from 'vue'

import { getMe, type Me } from './api/client.js'

export interface MeState {
  me: Me | null
  loading: boolean
  error: boolean
}

const ME_KEY: InjectionKey<MeState> = Symbol('me')

/** Build the reactive me-state and kick off the single `/api/me` fetch that fills it in. */
export function createMeState(): MeState {
  const state = reactive<MeState>({ me: null, loading: true, error: false })
  getMe().then(
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

/** The resolved identity and allowlist membership, plus its load state, for the nearest provider. */
export function useMe(): MeState {
  return inject(ME_KEY) ?? reactive<MeState>({ me: null, loading: false, error: true })
}
