<!--
  The tooltip primitive: a quiet underlined trigger with a bubble of detail that opens on hover and on
  focus, and can be pinned open by clicking. The bubble is teleported to the body and positioned against
  the trigger's box, so it escapes any clipping or stacking context the trigger sits in (a table cell, a
  scrolling log, a dialog) and flips above the trigger when there is no room below.

  It mounts nothing while closed, so a containing dialog keeps its own escape and focus handling. Escape
  closes the bubble and leaves focus on the trigger. With `inspectable`, activating the trigger emits
  `inspect` instead of pinning the bubble open, for a trigger whose click opens a fuller view.
-->
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Trigger text, when the default slot carries none. */
    label?: string
    /** The trigger's accessible name, when its visible text does not say enough on its own. */
    accessibleLabel?: string
    /** Activating the trigger opens a fuller view (emitting `inspect`) instead of pinning the bubble. */
    inspectable?: boolean
  }>(),
  { label: undefined, accessibleLabel: undefined, inspectable: false },
)

const emit = defineEmits<{ inspect: [] }>()
const open = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const contentEl = ref<HTMLElement | null>(null)
const contentPosition = ref({ left: '0px', top: '0px' })
const id = `tooltip-${useId()}`
let closeTimer: ReturnType<typeof setTimeout> | undefined
let openBeforePointer: boolean | undefined

function show(): void {
  if (closeTimer !== undefined) clearTimeout(closeTimer)
  open.value = true
  void nextTick(positionContent)
}

function positionContent(): void {
  const trigger = triggerEl.value
  const content = contentEl.value
  if (trigger === null || content === null || !open.value) return
  const triggerRect = trigger.getBoundingClientRect()
  const contentRect = content.getBoundingClientRect()
  const gap = 4
  const viewportPadding = 8
  const left = Math.min(
    Math.max(viewportPadding, triggerRect.left),
    Math.max(viewportPadding, window.innerWidth - contentRect.width - viewportPadding),
  )
  const below = triggerRect.bottom + gap
  const top =
    below + contentRect.height <= window.innerHeight - viewportPadding
      ? below
      : Math.max(viewportPadding, triggerRect.top - contentRect.height - gap)
  contentPosition.value = { left: `${left}px`, top: `${top}px` }
}

function scheduleClose(): void {
  closeTimer = setTimeout(() => {
    open.value = false
  }, 150)
}

function activate(): void {
  if (props.inspectable) emit('inspect')
  else if (openBeforePointer !== undefined) {
    open.value = !openBeforePointer
    openBeforePointer = undefined
    if (open.value) void nextTick(positionContent)
  } else open.value = true
}

function rememberPointerState(): void {
  openBeforePointer = open.value
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    escape(event)
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    activate()
  }
}

function escape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !open.value) return
  open.value = false
  event.stopPropagation()
}

function removeGlobalListeners(): void {
  document.removeEventListener('keydown', escape)
  window.removeEventListener('resize', positionContent)
  document.removeEventListener('scroll', positionContent, true)
}

watch(open, (isOpen) => {
  removeGlobalListeners()
  if (!isOpen) return
  document.addEventListener('keydown', escape)
  window.addEventListener('resize', positionContent)
  document.addEventListener('scroll', positionContent, true)
  void nextTick(positionContent)
})

onBeforeUnmount(() => {
  if (closeTimer !== undefined) clearTimeout(closeTimer)
  removeGlobalListeners()
})
</script>

<template>
  <span class="tooltip-root" @mouseenter="show" @mouseleave="scheduleClose">
    <button
      ref="triggerEl"
      type="button"
      class="tooltip-trigger"
      :aria-label="accessibleLabel"
      :aria-describedby="id"
      :aria-haspopup="inspectable ? 'dialog' : undefined"
      @focus="show"
      @blur="scheduleClose"
      @click="activate"
      @pointerdown="rememberPointerState"
      @keydown="onTriggerKeydown"
    >
      <slot>{{ label }}</slot>
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        :id="id"
        ref="contentEl"
        class="tooltip-content"
        role="tooltip"
        :style="contentPosition"
        @mouseenter="show"
        @mouseleave="scheduleClose"
      >
        <slot name="content" />
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.tooltip-root {
  position: relative;
  display: inline-flex;
}

.tooltip-trigger {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
  text-decoration-color: var(--color-border-strong);
  text-underline-offset: var(--space-1);
}

.tooltip-content {
  position: fixed;
  z-index: 2;
  width: max-content;
  max-width: min(24rem, calc(100vw - var(--space-6)));
  max-height: calc(100vh - var(--space-4));
  overflow-y: auto;
  padding: var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  color: var(--color-text);
  box-shadow: 0 var(--space-2) var(--space-5) var(--color-scrim);
  white-space: normal;
}
</style>
