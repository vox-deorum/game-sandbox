/**
 * Shared render helpers for routed pages (see plans/stage-04.5/testing-and-docs.md). The
 * environment, session, and replay suites all hand-rolled the same wrapper: a memory-history router
 * plus a render of the page under the MeProvider through a RouterView, so the one /api/me fetch backs
 * the page the way the real app wires it.
 */
import { render, within } from '@testing-library/vue'
import { expect } from 'vitest'
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

/**
 * Every badge's text under `container`, whitespace collapsed. A recipient badge reads "to P2" across
 * two elements ("to " plus the PlayerTag's compact id), so Testing Library's text matchers cannot see
 * it whole.
 */
export function badgeTexts(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll('.ui-badge')).map((badge) =>
    (badge.textContent ?? '').replace(/\s+/g, ' ').trim(),
  )
}

/**
 * Assert the game-over standings under `container`: one list row per entry of `rows`, best first,
 * each row showing every listed text (seat tag, agent label, score, and so on), plus the verdict line.
 */
export function expectStandings(container: HTMLElement, rows: string[][], verdict: string): void {
  const items = within(container).getAllByRole('listitem')
  expect(items).toHaveLength(rows.length)
  rows.forEach((texts, index) => {
    for (const text of texts) {
      expect(within(items[index] as HTMLElement).getByText(text)).toBeInTheDocument()
    }
  })
  expect(within(container).getByText(verdict)).toBeInTheDocument()
}
