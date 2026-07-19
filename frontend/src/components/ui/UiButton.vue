<!--
  The button primitive: renders a RouterLink when `to` is set, a native link when `href` is set, and
  a button otherwise, so links that look like buttons and real buttons share one look. Variants and
  sizes are the only styling knobs; pages must not restyle buttons with their own CSS (see
  docs/contributors/design.md).
-->
<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'tight' | 'md' | 'lg'
    /** Renders the button as a RouterLink to this target. */
    to?: string
    /** Renders the button as a native link to this target. Use for downloads and external URLs. */
    href?: string
    /** Suggests a filename when the native link downloads its target. */
    download?: string
    type?: 'button' | 'submit'
    disabled?: boolean
    /** A pending action: shows the busy state and blocks re-triggering. */
    loading?: boolean
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button',
    to: undefined,
    href: undefined,
    download: undefined,
    disabled: false,
    loading: false,
  },
)

// Loading implies disabled so a pending action cannot be fired twice.
const isDisabled = computed(() => props.disabled || props.loading)
</script>

<template>
  <RouterLink v-if="to" class="ui-button" :class="[variant, size]" :to="to">
    <slot />
  </RouterLink>
  <a
    v-else-if="href"
    class="ui-button"
    :class="[variant, size]"
    :href="href"
    :download="download"
  >
    <slot />
  </a>
  <button
    v-else
    class="ui-button"
    :class="[variant, size, { loading }]"
    :type="type"
    :disabled="isDisabled"
    :aria-busy="loading || undefined"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-4);
  transition:
    background-color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    filter var(--motion-fast) var(--ease-out);
}

.ui-button.tight {
  padding: var(--space-1) var(--space-4);
}

.ui-button.lg {
  font-size: var(--text-md);
  padding: var(--space-2) var(--space-5);
}

.ui-button.primary {
  background: var(--color-accent);
  color: var(--color-on-accent);
}

.ui-button.primary:hover {
  filter: brightness(1.08);
}

.ui-button.secondary {
  background: var(--color-surface-raised);
  color: var(--color-text);
  border-color: var(--color-border);
}

.ui-button.secondary:hover {
  border-color: var(--color-border-strong);
  filter: none;
}

.ui-button.ghost {
  background: transparent;
  color: var(--color-text);
}

.ui-button.ghost:hover {
  background: var(--color-surface-raised);
  filter: none;
}

.ui-button.danger {
  background: transparent;
  color: var(--color-danger);
  border-color: var(--color-danger);
}

.ui-button.danger:hover {
  background: var(--color-danger);
  color: var(--color-bg);
  filter: none;
}

.ui-button:disabled {
  opacity: 0.6;
  cursor: default;
  filter: none;
}

.ui-button.loading {
  cursor: progress;
}
</style>
