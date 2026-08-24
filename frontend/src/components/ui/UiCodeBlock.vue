<!--
  A monospace command block with a copy button in its corner. The button copies the block's exact
  text, shows a checkmark or a cross while the result is fresh, and announces the result to screen
  readers through a status region.
-->
<script setup lang="ts">
import { Check, Copy, X } from '@lucide/vue'
import { onBeforeUnmount, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** The exact text the block shows and the button copies. */
    code: string
    /** The accessible name of the copy button. */
    copyLabel?: string
  }>(),
  { copyLabel: 'Copy code' },
)

const state = ref<'idle' | 'copied' | 'failed'>('idle')
const message = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

async function copyCode(): Promise<void> {
  clearTimeout(timer)
  try {
    await navigator.clipboard.writeText(props.code)
    state.value = 'copied'
    message.value = 'Copied.'
  } catch {
    state.value = 'failed'
    message.value = 'Copy failed.'
  }
  timer = setTimeout(() => {
    state.value = 'idle'
    message.value = ''
  }, 2000)
}

onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="ui-code-block">
    <pre><code>{{ code }}</code></pre>
    <button type="button" class="copy" :class="state" :aria-label="copyLabel" @click="copyCode">
      <Copy v-if="state === 'idle'" :size="16" aria-hidden="true" />
      <Check v-else-if="state === 'copied'" :size="16" aria-hidden="true" />
      <X v-else :size="16" aria-hidden="true" />
    </button>
    <span class="sr-only" role="status">{{ message }}</span>
  </div>
</template>

<style scoped>
.ui-code-block {
  position: relative;
}

.ui-code-block pre {
  margin: 0;
  padding: var(--space-3);
  padding-right: var(--space-7);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.copy {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: inline-flex;
  padding: var(--space-1);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.copy:hover {
  background: var(--color-surface-raised);
  border-color: var(--color-border);
  color: var(--color-text);
}

.copy.copied {
  color: var(--color-success);
}

.copy.failed {
  color: var(--color-danger);
}
</style>
