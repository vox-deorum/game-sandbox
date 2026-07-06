<!--
  Documentation: the in-app home for the student guides. The backend serves the raw markdown under
  docs/students/; this page fetches the navigation manifest once, then the current page's markdown, and
  renders it with DocsMarkdown. The landing (/docs) is the students index, or a deployment's class-index
  override when DOCS_INDEX_FILE is set. Deep links like /docs/students/environments/hearts resolve
  through the manifest, so a hard refresh or a shared URL lands on the right guide.
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  type DocsManifest,
  type DocsNavEntry,
  type DocsPage,
  getDocsIndex,
  getDocsManifest,
  getDocsPage,
} from '../api/client.js'
import DocsMarkdown from '../components/DocsMarkdown.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { routeForDocPath } from '../docs/markdown.js'

const route = useRoute()

const manifest = ref<DocsManifest | null>(null)
// Whether the manifest fetch succeeded. A deep link resolves through the manifest, so when it fails we
// fall back to deriving the source path straight from the route rather than dead-ending every guide.
const manifestLoaded = ref(true)
const page = ref<DocsPage | null>(null)
const status = ref<'loading' | 'ready' | 'notfound' | 'error'>('loading')

const navPages = computed(() => manifest.value?.pages ?? [])

// Every page and section route mapped back to its docs-relative source path, so a deep-linked route
// resolves to the file to fetch without the frontend guessing at path shapes.
const routeToSource = computed(() => {
  const map = new Map<string, string>()
  const walk = (entries: DocsNavEntry[]): void => {
    for (const entry of entries) {
      map.set(routeForDocPath(entry.path), entry.path)
      if (entry.children !== undefined) walk(entry.children)
    }
  }
  walk(navPages.value)
  return map
})

const isLanding = computed(() => route.path === '/docs' || route.path === '/docs/')

function isActive(entry: DocsNavEntry): boolean {
  return route.path === routeForDocPath(entry.path)
}

/**
 * The docs-relative source path a route should fetch: the manifest entry when present (which also maps
 * a section route to its `index.md`), otherwise undefined so an unlisted route is a not-found. Only when
 * the manifest itself failed to load do we derive a leaf source from the route, so a shared deep link
 * still resolves through a manifest outage; the backend answers 404 if that guess does not exist.
 */
function sourceForRoute(path: string): string | undefined {
  const mapped = routeToSource.value.get(path)
  if (mapped !== undefined) return mapped
  if (manifestLoaded.value) return undefined
  const rel = path.replace(/^\/docs\//, '')
  return rel.startsWith('students/') ? `${rel}.md` : undefined
}

/** Scroll to the hash target after a render, else reset the main scroll region to the top. */
function scrollAfterRender(): void {
  try {
    const hash = route.hash
    if (hash.length > 1) {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)))
      if (el !== null && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView()
        return
      }
    }
    const main = document.querySelector('.app-main')
    if (main !== null) main.scrollTop = 0
  } catch {
    // Scrolling is a nicety; a headless environment without layout must not break navigation.
  }
}

async function loadPage(): Promise<void> {
  status.value = 'loading'
  try {
    if (isLanding.value) {
      page.value = await getDocsIndex()
    } else {
      const source = sourceForRoute(route.path)
      if (source === undefined) {
        page.value = null
        status.value = 'notfound'
        return
      }
      page.value = await getDocsPage(source)
    }
    status.value = 'ready'
  } catch (error) {
    // A 404 (ApiError carries the status) means the guide does not exist: a not-found, distinct from a
    // transport or server failure. This also covers a derived-source guess that turned out not to be a
    // real page.
    if ((error as { status?: number } | null)?.status === 404) {
      page.value = null
      status.value = 'notfound'
      return
    }
    status.value = 'error'
    return
  }
  await nextTick()
  scrollAfterRender()
}

onMounted(async () => {
  try {
    manifest.value = await getDocsManifest()
  } catch {
    // The nav can fail independently of a page; the landing still loads without it, and a deep link
    // falls back to a route-derived source (see sourceForRoute) instead of a spurious not-found.
    manifest.value = { pages: [] }
    manifestLoaded.value = false
  }
  await loadPage()
})

// A path change loads the new page (and re-scrolls); a hash-only change just scrolls within the page.
watch(
  () => route.path,
  () => {
    void loadPage()
  },
)
watch(
  () => route.hash,
  () => {
    scrollAfterRender()
  },
)
</script>

<template>
  <section class="docs">
    <aside class="docs-nav-panel">
      <p class="docs-nav-title">Documentation</p>
      <nav class="docs-nav" aria-label="Documentation">
        <RouterLink class="docs-nav-link" :class="{ active: isLanding }" to="/docs">
          Overview
        </RouterLink>
        <template v-for="entry in navPages" :key="entry.path">
          <RouterLink
            class="docs-nav-link"
            :class="{ active: isActive(entry) }"
            :to="routeForDocPath(entry.path)"
          >
            {{ entry.title }}
          </RouterLink>
          <ul v-if="entry.children?.length" class="docs-nav-children">
            <li v-for="child in entry.children" :key="child.path">
              <RouterLink
                class="docs-nav-link child"
                :class="{ active: isActive(child) }"
                :to="routeForDocPath(child.path)"
              >
                {{ child.title }}
              </RouterLink>
            </li>
          </ul>
        </template>
      </nav>
    </aside>

    <div class="docs-content">
      <UiEmptyState v-if="status === 'loading'">Loading…</UiEmptyState>
      <UiEmptyState v-else-if="status === 'error'" tone="danger">
        Could not load the documentation.
      </UiEmptyState>
      <div v-else-if="status === 'notfound'" class="docs-missing">
        <UiEmptyState>That documentation page was not found.</UiEmptyState>
        <RouterLink to="/docs">Back to the documentation home</RouterLink>
      </div>
      <DocsMarkdown v-else-if="page !== null" :content="page.content" :doc-path="page.path" />
    </div>
  </section>
</template>

<style scoped>
.docs {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: var(--space-6);
  align-items: start;
}

.docs-nav-panel {
  position: sticky;
  top: var(--space-4);
}

.docs-nav-title {
  margin: 0 0 var(--space-3);
  font-family: var(--font-heading);
  font-size: var(--text-lg);
}

.docs-nav {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.docs-nav-children {
  list-style: none;
  margin: var(--space-1) 0 var(--space-1) var(--space-3);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  border-left: 1px solid var(--color-border);
}

.docs-nav-link {
  display: block;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  text-decoration: none;
  font-size: var(--text-sm);
}

.docs-nav-link:hover {
  color: var(--color-text);
  background: var(--color-surface);
}

.docs-nav-link.active {
  color: var(--color-text);
  background: var(--color-surface-raised);
  font-weight: 600;
}

.docs-content {
  min-width: 0;
  max-width: 48rem;
}

.docs-missing {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}

@media (max-width: 768px) {
  .docs {
    grid-template-columns: minmax(0, 1fr);
  }

  .docs-nav-panel {
    position: static;
  }
}
</style>
