<!-- Shared renderer-and-log frame for live sessions and replays. Transport and log content stay with callers. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    aspectRatio: number | null
    logBeside: boolean
    loading?: boolean
    loadingLabel?: string
    canvasLabel: string
    stageLabel?: string
    besideLogLabel?: string
  }>(),
  { loading: false, loadingLabel: 'Loading…', stageLabel: undefined },
)

const emit = defineEmits<{
  rendererHost: [HTMLElement | null]
  keydown: [KeyboardEvent]
}>()

const rendererHost = ref<HTMLElement | null>(null)
const portrait = computed(() => props.aspectRatio !== null && props.aspectRatio < 1)

onMounted(() => emit('rendererHost', rendererHost.value))
onBeforeUnmount(() => emit('rendererHost', null))
</script>

<template>
  <div
    class="stage"
    :class="[portrait ? 'portrait' : 'landscape', logBeside ? 'beside' : 'below']"
    :tabindex="stageLabel === undefined ? undefined : 0"
    :role="stageLabel === undefined ? undefined : 'group'"
    :aria-label="stageLabel"
    @keydown="emit('keydown', $event)"
  >
    <section class="stage-canvas" :aria-label="canvasLabel">
      <div
        ref="rendererHost"
        class="renderer-host"
        :style="
          aspectRatio === null
            ? undefined
            : { aspectRatio: String(aspectRatio), '--stage-aspect': String(aspectRatio) }
        "
      >
        <slot name="overlay" />
      </div>
      <slot name="renderer-status" />
    </section>

    <div v-if="loading" class="stage-log stage-loading" role="status">
      <span class="overlay-spinner" aria-hidden="true" />
      <span>{{ loadingLabel }}</span>
    </div>
    <section
      v-else-if="logBeside && $slots['beside-log']"
      class="stage-log"
      :aria-label="besideLogLabel"
    >
      <div class="stage-log-body"><slot name="beside-log" /></div>
    </section>
    <div v-if="!loading" class="below-slots"><slot name="below-log" /></div>
  </div>
</template>

<style scoped>
.stage { display: grid; gap: var(--space-4); }
.stage:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: var(--space-2); border-radius: var(--radius-md); }
.stage.beside { align-items: stretch; }
.stage.beside.portrait { grid-template-columns: minmax(0, 22rem) minmax(0, 1fr); }
.stage.beside.landscape { grid-template-columns: minmax(0, 1fr) minmax(0, 16rem); }
.stage.beside .stage-canvas { grid-column: 1; }
.stage.beside .stage-log { grid-column: 2; }
.stage.beside .stage-canvas, .stage.beside .stage-log { display: flex; flex-direction: column; min-height: 0; }
.stage.below { grid-template-columns: minmax(0, 1fr); justify-items: center; }
.stage.below .stage-canvas { width: 100%; }
.renderer-host { position: relative; width: 100%; margin: 0 auto; background: var(--color-stage-backdrop); border-radius: var(--radius-md); overflow: hidden; }
.stage.portrait .renderer-host { max-width: 480px; }
.stage.landscape .renderer-host { max-width: calc(min(70vh, 640px) * var(--stage-aspect, 1.333)); }
.stage.beside .stage-log-body { position: relative; flex: 1; min-height: 0; }
.stage.beside .stage-log-body :deep(.decision-log),
.stage.beside .stage-log-body :deep(.chat-panel),
.stage.beside .stage-log-body :deep(.game-thread) { position: absolute; inset: 0; }
.stage-loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-3); padding: var(--space-6) 0; color: var(--color-text-muted); font-size: var(--text-md); }
.overlay-spinner { width: 2rem; height: 2rem; border-radius: 50%; border: 3px solid var(--color-border); border-top-color: var(--color-accent); animation: overlay-spin var(--motion-spinner) linear infinite; }
@keyframes overlay-spin { to { transform: rotate(360deg); } }
.below-slots { display: contents; }
.below-slots :deep(.stage-log-below) { width: 100%; max-width: 480px; }
.stage.beside .below-slots :deep(.stage-decision-below) { grid-column: 1 / -1; max-width: 100%; }
.stage.below.landscape .below-slots :deep(.stage-log-below) { max-width: 100%; }
.below-slots :deep(.stage-log-below summary) { cursor: pointer; padding: var(--space-2) 0; font-family: var(--font-heading); font-size: var(--text-md); }
.below-slots :deep(.stage-log-below .decision-log) { max-height: 12rem; }
.below-slots :deep(.stage-chat-below .chat-panel),
.below-slots :deep(.stage-thread-below .game-thread) { max-height: 16rem; }
@media (max-width: 768px) {
  .stage.beside { grid-template-columns: minmax(0, 1fr); justify-items: center; }
}
</style>
