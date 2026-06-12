<!--
  The slider primitive, wrapping Reka UI Slider for keyboard operation and value announcement
  (arrows step, Home and End jump, aria-valuenow tracks the position). Single-thumb only: the
  number model converts to and from Reka's thumb array. Used by the replay scrubber.
-->
<script setup lang="ts">
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'
import { computed } from 'vue'

const model = defineModel<number>({ required: true })

const props = withDefaults(
  defineProps<{
    /** Accessible name announced for the thumb. */
    label: string
    max: number
    min?: number
    step?: number
    disabled?: boolean
  }>(),
  { min: 0, step: 1, disabled: false },
)

// Reka models one array entry per thumb; this primitive is single-thumb by design.
const thumbValues = computed({
  get: () => [model.value],
  set: (values) => {
    model.value = values[0] ?? props.min
  },
})
</script>

<template>
  <SliderRoot
    v-model="thumbValues"
    class="ui-slider"
    :max="max"
    :min="min"
    :step="step"
    :disabled="disabled"
  >
    <SliderTrack class="ui-slider-track">
      <SliderRange class="ui-slider-range" />
    </SliderTrack>
    <SliderThumb class="ui-slider-thumb" :aria-label="label" />
  </SliderRoot>
</template>

<style scoped>
.ui-slider {
  position: relative;
  display: flex;
  align-items: center;
  user-select: none;
  touch-action: none;
  width: 100%;
  height: var(--space-5);
}

.ui-slider-track {
  position: relative;
  flex-grow: 1;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
}

.ui-slider-range {
  position: absolute;
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

.ui-slider-thumb {
  display: block;
  width: var(--space-4);
  height: var(--space-4);
  border-radius: var(--radius-full);
  background: var(--color-accent);
  cursor: grab;
  transition: filter var(--motion-fast) var(--ease-out);
}

.ui-slider-thumb:hover {
  filter: brightness(1.1);
}

.ui-slider[data-disabled] .ui-slider-thumb {
  cursor: default;
  opacity: 0.6;
}
</style>
