<!--
  The toast primitive: a transient, non-blocking notice rendered bottom-center, teleported to the
  body so it escapes every layout context. One host mounts in AppShell.vue; feature components push
  messages through the shared useToast() queue. Each toast carries role="status" so a screen reader
  announces it, auto-dismisses after a few seconds, and dismisses on click. The queue is empty by
  default, so the host renders nothing until a toast is shown.
-->
<script setup lang="ts">
import { useToast } from '../../toast.js'

const { toasts, dismiss } = useToast()
</script>

<template>
  <Teleport to="body">
    <div v-if="toasts.length > 0" class="toast-host" aria-live="polite">
      <button
        v-for="toast in toasts"
        :key="toast.id"
        type="button"
        class="toast"
        role="status"
        @click="dismiss(toast.id)"
      >
        {{ toast.message }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 50%;
  bottom: var(--space-5);
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  max-width: min(28rem, calc(100vw - var(--space-6)));
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
  box-shadow: 0 var(--space-2) var(--space-5) var(--color-scrim);
}
</style>
