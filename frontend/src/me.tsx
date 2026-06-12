/**
 * The app-shell identity context. The shell fetches `GET /api/me` once at startup so the header can
 * show "signed in as ⟨user⟩" and every page can learn whether the user may start sessions, without
 * each page refetching. Pages read it through {@link useMe}.
 *
 * When OAuth lands this is the seam it drops into: the provider keeps the same shape, only its source
 * changes from the mock auto-logon to the real session.
 */
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'

import { getMe, type Me } from './api/client.js'

export interface MeState {
  me: Me | null
  loading: boolean
  error: boolean
}

const MeContext = createContext<MeState>({ me: null, loading: true, error: false })

export function MeProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<MeState>({ me: null, loading: true, error: false })

  useEffect(() => {
    let active = true
    getMe().then(
      (me) => {
        if (active) {
          setState({ me, loading: false, error: false })
        }
      },
      () => {
        if (active) {
          setState({ me: null, loading: false, error: true })
        }
      },
    )
    return () => {
      active = false
    }
  }, [])

  return <MeContext.Provider value={state}>{children}</MeContext.Provider>
}

/** The resolved identity and allowlist membership, plus its load state. */
export function useMe(): MeState {
  return useContext(MeContext)
}
