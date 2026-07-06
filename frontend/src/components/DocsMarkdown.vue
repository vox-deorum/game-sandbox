<!--
  Renders one documentation page's markdown and keeps its in-app links inside the SPA. The renderer
  tags cross-page student links `data-internal`; a single delegated click handler turns those into
  router navigations (so a fragment like #time-limits lands on the right page and scrolls), while
  external and GitHub links keep their native new-tab behavior. The prose styling is the app's own
  design tokens, so the guides read as part of the site rather than an embedded document.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import { renderDocsMarkdown } from '../docs/markdown.js'

const props = defineProps<{ content: string; docPath: string }>()
const router = useRouter()

const html = computed(() => renderDocsMarkdown(props.content, props.docPath))

// Delegate clicks: intercept only plain-clicks on internal doc links so router navigation drives them.
// Modified clicks (new tab/window) and every non-internal link keep their default behavior.
function onClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const anchor = (event.target as HTMLElement).closest('a[data-internal]')
  if (anchor === null) return
  const href = anchor.getAttribute('href')
  if (href === null) return
  event.preventDefault()
  void router.push(href)
}
</script>

<template>
  <!-- Content is trusted (repo guides plus an operator-set index) and markdown-it runs with html:false. -->
  <div class="docs-prose" @click="onClick" v-html="html" />
</template>

<style scoped>
.docs-prose {
  color: var(--color-text);
  line-height: 1.65;
  overflow-wrap: break-word;
}

.docs-prose :deep(h1),
.docs-prose :deep(h2),
.docs-prose :deep(h3),
.docs-prose :deep(h4) {
  font-family: var(--font-heading);
  line-height: 1.25;
  margin: var(--space-6) 0 var(--space-3);
}

.docs-prose :deep(h1) {
  font-size: var(--text-2xl);
  margin-top: 0;
}

.docs-prose :deep(h2) {
  font-size: var(--text-xl);
}

.docs-prose :deep(h3) {
  font-size: var(--text-lg);
}

.docs-prose :deep(p),
.docs-prose :deep(ul),
.docs-prose :deep(ol) {
  margin: var(--space-3) 0;
}

.docs-prose :deep(a) {
  color: var(--color-accent);
  text-decoration: none;
}

.docs-prose :deep(a:hover) {
  text-decoration: underline;
}

.docs-prose :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--color-surface-raised);
  padding: 0.15em 0.35em;
  border-radius: var(--radius-sm);
}

.docs-prose :deep(pre.hljs) {
  margin: var(--space-4) 0;
  padding: var(--space-4);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow-x: auto;
}

.docs-prose :deep(pre.hljs code) {
  background: none;
  padding: 0;
  font-size: var(--text-sm);
}

.docs-prose :deep(blockquote) {
  margin: var(--space-4) 0;
  padding: var(--space-2) var(--space-4);
  border-left: 3px solid var(--color-border-strong);
  background: var(--color-surface);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  color: var(--color-text-muted);
}

.docs-prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: var(--space-4) 0;
  font-size: var(--text-sm);
  display: block;
  overflow-x: auto;
}

.docs-prose :deep(th),
.docs-prose :deep(td) {
  border: 1px solid var(--color-border);
  padding: var(--space-2) var(--space-3);
  text-align: left;
  vertical-align: top;
}

.docs-prose :deep(th) {
  background: var(--color-surface-raised);
  font-weight: 600;
}

.docs-prose :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: var(--space-6) 0;
}

.docs-prose :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
