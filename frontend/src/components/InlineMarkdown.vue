<!-- A safe inline-Markdown wrapper for compact, public-facing user-authored prose. -->
<script setup lang="ts">
import { computed } from 'vue'

import { renderInlineMarkdown } from '../markdown/inline.js'

const props = defineProps<{ markdown: string }>()
const rendered = computed(() => renderInlineMarkdown(props.markdown))
</script>

<template>
  <span class="inline-markdown" v-html="rendered" />
</template>

<style scoped>
.inline-markdown :deep(a) {
  position: relative;
  z-index: 1;
  pointer-events: auto;
  color: var(--color-accent);
  text-decoration: underline;
}
</style>
