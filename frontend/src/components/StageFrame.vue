<!-- Shared renderer-and-log frame for live sessions and replays. Transport and log content stay with callers.
  Fullscreen lives here, not in the renderers: the native API needs the host element and the CSS
  fallback needs the stage canvas, both of which are this component's alone. -->
<script setup lang="ts">
import { Maximize, Minimize } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useFullscreen } from '../composables/useFullscreen.js'

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

const stageCanvas = ref<HTMLElement | null>(null)
const { isFullscreen, usesFallback, toggle } = useFullscreen(stageCanvas)

// The parent binds v-model:fullscreen so it can mirror the session stage; when absent the model
// defaults internally to false and the internal local state still works. The host writes the model
// one-way (isFullscreen stays the single source of truth), so the parent reads it rather than driving
// it: programmatic open-from-parent is deliberately unsupported.
const fullscreen = defineModel<boolean>('fullscreen', { default: false })
watch(isFullscreen, (active) => {
  fullscreen.value = active
  // Leaving fullscreen brings the bar back and stops the idle timer so it cannot re-hide later.
  if (!active) {
    controlsIdle.value = false
    focusInControls.value = false
    if (controlsTimer !== null) {
      window.clearTimeout(controlsTimer)
      controlsTimer = null
    }
  }
})

// Auto-hide of the fullscreen controls: they fade once the pointer goes idle while fullscreen, and
// reveal again on any pointer or focus activity. Focus in the controls keeps them from hiding.
const CONTROLS_IDLE_MS = 2500
const controlsIdle = ref(false)
const focusInControls = ref(false)
let controlsTimer: number | null = null

function armControlsTimer(): void {
  if (controlsTimer !== null) {
    window.clearTimeout(controlsTimer)
  }
  controlsTimer = window.setTimeout(() => {
    // Never hide while a control inside the bar itself still has focus.
    if (!focusInControls.value) {
      controlsIdle.value = true
    }
    controlsTimer = null
  }, CONTROLS_IDLE_MS)
}

function revealControls(): void {
  controlsIdle.value = false
  if (isFullscreen.value) {
    armControlsTimer()
  }
}

function onStageFocusIn(event: FocusEvent): void {
  // Only focus in the transport bar itself deserves to keep the controls visible; a focused toggle
  // (or anything else on the canvas) must still allow the idle timer to fade them, so it is excluded.
  focusInControls.value =
    event.target instanceof HTMLElement &&
    event.target.closest('.fullscreen-controls') !== null
  revealControls()
}

function onStageFocusOut(event: FocusEvent): void {
  // Once focus leaves the stage entirely, nothing in the bar holds it anymore; if it moved to another
  // control inside the bar, that control keeps the auto-hide armed off.
  const next = event.relatedTarget
  focusInControls.value = next instanceof HTMLElement && next.closest('.fullscreen-controls') !== null
  // A timer that expired while the bar held focus never rescheduled, so leaving the bar re-arms the
  // idle countdown; without this the controls would stay visible until the next pointer or focus event.
  if (!focusInControls.value && isFullscreen.value) {
    armControlsTimer()
  }
}

onMounted(() => emit('rendererHost', rendererHost.value))
onBeforeUnmount(() => {
  if (controlsTimer !== null) {
    window.clearTimeout(controlsTimer)
  }
  emit('rendererHost', null)
})
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
    <section
      ref="stageCanvas"
      class="stage-canvas"
      :class="[
        isFullscreen ? 'is-fullscreen' : '',
        isFullscreen && usesFallback ? 'fallback-fullscreen' : '',
        isFullscreen && controlsIdle ? 'controls-idle' : '',
      ]"
      :aria-label="canvasLabel"
      @pointermove="revealControls"
      @pointerdown="revealControls"
      @focusin="onStageFocusIn"
      @focusout="onStageFocusOut"
    >
      <div
        ref="rendererHost"
        class="renderer-host"
        :style="
          aspectRatio === null
            ? undefined
            : { aspectRatio: String(aspectRatio), '--stage-aspect': String(aspectRatio) }
        "
      >
        <!-- Overlay-slot content must NOT teleport to document.body: teleported content is invisible
          during native fullscreen. Nothing teleports in this slot today; keep it that way. -->
        <slot name="overlay" />
        <!-- The renderers wire pointerdown/touchstart on .renderer-host (flappy's flap, crane's camera
          drag). The toggle sits top-LEFT so it stays clear of three_branches' top-right chrome strip
          (its Recenter/collision plates at ui/chrome.ts); the renderers' canvas input listeners would
          still swallow a click on a top-right button. The .stop shielding below keeps this button's
          own clicks from flapping or dragging, and from reaching the renderer handlers at all. -->
        <button
          v-if="aspectRatio !== null"
          type="button"
          class="fullscreen-toggle"
          :aria-label="isFullscreen ? 'Exit full screen' : 'Enter full screen'"
          @pointerdown.stop
          @touchstart.stop
          @click.stop
          @dblclick.stop
          @click="toggle"
        >
          <Maximize v-if="!isFullscreen" :size="20" aria-hidden="true" />
          <Minimize v-else :size="20" aria-hidden="true" />
        </button>
      </div>
      <slot name="renderer-status" />
      <div v-if="isFullscreen && $slots['fullscreen-controls']" class="fullscreen-controls">
        <slot name="fullscreen-controls" />
      </div>
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
.stage-canvas.is-fullscreen { position: relative; display: flex; align-items: center; justify-content: center; background: var(--color-stage-backdrop); }
.stage-canvas.fallback-fullscreen { position: fixed; inset: 0; z-index: 60; }
.stage-canvas.is-fullscreen .renderer-host { width: min(100%, calc(100dvh * var(--stage-aspect, 1.333))); max-width: none; margin: 0; border-radius: 0; }
.stage-canvas::backdrop { background: #000; }
.fullscreen-toggle { position: absolute; top: var(--space-2); left: var(--space-2); z-index: 1; display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--color-text-muted); opacity: 0.6; cursor: pointer; transition: opacity var(--motion-base) var(--ease-out); }
.fullscreen-toggle:hover, .fullscreen-toggle:focus-visible { opacity: 1; color: var(--color-text); }
.fullscreen-toggle:focus-visible { outline: 2px solid var(--color-focus-ring); }
.fullscreen-controls { position: absolute; bottom: var(--space-3); left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-radius: var(--radius-lg); background: var(--color-scrim); opacity: 1; transition: opacity var(--motion-base) var(--ease-out); }
.stage-canvas.controls-idle .fullscreen-toggle,
.stage-canvas.controls-idle .fullscreen-controls { opacity: 0; pointer-events: none; }
.stage-canvas.controls-idle .fullscreen-toggle:focus-visible { opacity: 1; pointer-events: auto; color: var(--color-text); }
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
