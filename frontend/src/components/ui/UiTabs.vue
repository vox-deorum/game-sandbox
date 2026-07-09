<!--
  The tab-strip primitive: a row of buttons acting as a single-select control, for filters and section
  switches that are not routes (see UsersAdminPage's status tabs). Unlike ExperimentTabs (RouterLinks
  to distinct pages), this is a plain v-model over the given tab keys — selecting a tab never navigates.

  Follows the WAI-ARIA tabs pattern's roving tabindex: only the active tab is in the Tab order, and
  arrow/Home/End move both the selection and DOM focus among the buttons.
-->
<script setup lang="ts" generic="K extends string">
import { computed, type ComponentPublicInstance } from 'vue'

const model = defineModel<K>({ required: true })

const props = defineProps<{
  tabs: { key: K; label: string }[]
}>()

const tabRefs = new Map<K, HTMLButtonElement>()

function setTabRef(key: K, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLButtonElement) {
    tabRefs.set(key, el)
  } else {
    tabRefs.delete(key)
  }
}

// The tab the roving-tabindex and arrow-key logic treats as "current": the one matching the model,
// or the first tab if the model doesn't match any of them. Without this fallback, a model that
// doesn't match a tab would leave every button at tabindex -1 (unreachable by keyboard) and would
// make ArrowLeft/ArrowRight land on different tabs depending on direction.
const activeIndex = computed(() => {
  const index = props.tabs.findIndex((tab) => tab.key === model.value)
  return index === -1 ? 0 : index
})

function focusTab(key: K): void {
  tabRefs.get(key)?.focus()
}

function selectAt(index: number): void {
  const next = props.tabs[index]
  if (next !== undefined) {
    model.value = next.key
    focusTab(next.key)
  }
}

/** Move the selection left/right among `tabs`, wrapping at the ends, and follow it with focus. */
function selectByOffset(offset: number): void {
  selectAt((activeIndex.value + offset + props.tabs.length) % props.tabs.length)
}

function selectFirst(): void {
  selectAt(0)
}

function selectLast(): void {
  selectAt(props.tabs.length - 1)
}
</script>

<template>
  <div class="ui-tabs" role="tablist">
    <button
      v-for="(tab, index) in tabs"
      :key="tab.key"
      :ref="(el) => setTabRef(tab.key, el)"
      type="button"
      role="tab"
      class="ui-tab"
      :class="{ active: tab.key === model }"
      :aria-selected="tab.key === model"
      :tabindex="index === activeIndex ? 0 : -1"
      @click="model = tab.key"
      @keydown.left.prevent="selectByOffset(-1)"
      @keydown.right.prevent="selectByOffset(1)"
      @keydown.home.prevent="selectFirst"
      @keydown.end.prevent="selectLast"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<style scoped>
.ui-tabs {
  display: flex;
  gap: var(--space-1);
  border-bottom: 1px solid var(--color-border);
}

.ui-tab {
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.ui-tab:hover {
  color: var(--color-text);
}

.ui-tab.active {
  color: var(--color-text);
  font-weight: 600;
  border-bottom-color: var(--color-accent);
}
</style>
