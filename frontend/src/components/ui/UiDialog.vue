<!--
  The modal dialog primitive, wrapping Reka UI Dialog for the behavior that is hard to hand-roll:
  the focus trap, escape to close, focus restoration to the trigger, and aria-modal semantics. The
  dialog is controlled: the parent owns `open` through the v-model. Content renders on a UiCard-like
  surface over the scrim.
-->
<script setup lang="ts">
import { X } from '@lucide/vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'

const open = defineModel<boolean>('open', { required: true })

const props = withDefaults(
  defineProps<{
    title: string
    /** Optional one-line description announced with the title. */
    description?: string
    /** Whether Escape, outside interaction, and the header X may dismiss the dialog. */
    dismissible?: boolean
  }>(),
  { dismissible: true },
)

function preventDismiss(event: Event): void {
  if (!props.dismissible) event.preventDefault()
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="ui-dialog-overlay" />
      <DialogContent
        class="ui-dialog-content"
        :aria-describedby="description ? undefined : ''"
        @escape-key-down="preventDismiss"
        @pointer-down-outside="preventDismiss"
        @interact-outside="preventDismiss"
      >
        <div class="ui-dialog-header">
          <DialogTitle class="ui-dialog-title">{{ title }}</DialogTitle>
          <button v-if="dismissible" type="button" class="ui-dialog-close" aria-label="Close" @click="open = false">
            <X :size="16" aria-hidden="true" />
          </button>
        </div>
        <DialogDescription v-if="description" class="ui-dialog-description">
          {{ description }}
        </DialogDescription>
        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ui-dialog-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-scrim);
}

.ui-dialog-content {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(28rem, calc(100vw - var(--space-6)));
  max-height: 85vh;
  overflow-y: auto;
  padding: var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

/* The header line: the title leads, and the X close button sits at the far right. */
.ui-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.ui-dialog-title {
  margin: 0 0 var(--space-2);
  font-size: var(--text-xl);
}

/* The universal close affordance. Every dialog closes through this button. */
.ui-dialog-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  margin-top: calc(var(--space-1) * -1);
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  padding: 0;
}

.ui-dialog-close:hover {
  color: var(--color-text);
  background: var(--color-surface-raised);
}

.ui-dialog-description {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
</style>
