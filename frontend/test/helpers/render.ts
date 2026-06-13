/**
 * Shared render helpers for routed pages (see plans/stage-04.5/testing-and-docs.md). The
 * environment, session, and replay suites all hand-rolled the same wrapper: a memory-history router
 * plus a render of the page under the MeProvider through a RouterView, so the one /api/me fetch backs
 * the page the way the real app wires it.
 */
import { render } from '@testing-library/vue'
import { h } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  type RouteRecordRaw,
  type Router,
  RouterView,
} from 'vue-router'

import { MeProvider } from '../../src/me.js'

/** A memory-history router over a suite's routes. */
export function memoryRouter(routes: RouteRecordRaw[]): Router {
  return createRouter({ history: createMemoryHistory(), routes })
}

/**
 * Render the routed page under the MeProvider and the given router. Push the path and await
 * `router.isReady()` before calling so the router resolves the page first.
 */
export function renderWithMe(router: Router): ReturnType<typeof render> {
  return render(MeProvider, {
    slots: { default: () => h(RouterView) },
    global: { plugins: [router] },
  })
}
