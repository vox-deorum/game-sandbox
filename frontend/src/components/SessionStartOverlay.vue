<!-- The shared initial-start gate for local play and owned platform sessions. It stays inside the
  stage slot so native fullscreen includes it and its event shielding reaches renderer listeners. -->
<script setup lang="ts">
import UiButton from './ui/UiButton.vue'

defineProps<{
  ready: boolean
  pending: boolean
}>()

const emit = defineEmits<{
  start: []
}>()
</script>

<template>
  <div
    class="session-start-overlay"
    role="group"
    aria-label="Start game"
    @pointerdown.stop
    @touchstart.stop
    @click.stop
    @dblclick.stop
  >
    <p>Select Start when you are ready.</p>
    <UiButton :disabled="!ready" :loading="pending" @click="emit('start')">Start</UiButton>
  </div>
</template>

<style scoped>
.session-start-overlay {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--color-scrim);
  color: var(--color-text);
  font-size: var(--text-md);
  text-align: center;
}

.session-start-overlay p {
  margin: 0;
}
</style>
