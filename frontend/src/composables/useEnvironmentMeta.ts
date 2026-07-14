/**
 * The fetch-environments-and-find-one pattern that the environment, session, and replay pages all
 * repeat (see plans/stage-04.5/page-restructure.md). It fetches the public environment list once and
 * resolves the single environment by id, exposing the result as reactive state plus a `ready`
 * promise so a page can await it inside a larger mount flow (the session page mounts a renderer only
 * after the metadata is known).
 *
 * Home is deliberately not a caller: it renders the whole list, not one environment.
 */
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { type MaybeRefOrGetter, type Ref, ref, toValue } from 'vue'

import { environmentMeta } from '../environmentCatalog.js'

export interface UseEnvironmentMeta {
  /** The resolved environment, or null until `ready` settles (and when it is not found). */
  meta: Ref<EnvironmentMeta | null>
  /** True once the fetch failed or the id matched no environment. */
  notFound: Ref<boolean>
  /** False once the fetch has settled, either way. */
  loading: Ref<boolean>
  /** Resolves after the fetch settles, so callers can sequence work after the lookup. */
  ready: Promise<void>
}

export function useEnvironmentMeta(envId: MaybeRefOrGetter<string>): UseEnvironmentMeta {
  const meta = ref<EnvironmentMeta | null>(null)
  const notFound = ref(false)
  const loading = ref(true)

  const ready = (async (): Promise<void> => {
    const id = toValue(envId)
    const found = await environmentMeta(id).catch(() => null)
    if (found === null) {
      notFound.value = true
    } else {
      meta.value = found
    }
    loading.value = false
  })()

  return { meta, notFound, loading, ready }
}
