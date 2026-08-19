<!--
  The transport control set for a replay: play/pause, step back/forward, a position scrubber, and a
  tick/count readout. Presentational by design — it takes the transport's current state and the transport
  itself as props and renders every control widget; the pin button is page business, not a transport
  control, so it stays with the page. The root is `display: contents`, so whichever flex row this lands
  in (the page's controls row or the fullscreen overlay bar) treats the controls as its own direct items.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { type ReplayState, type ReplayTransport as ReplayTransportClass } from '../replay/transport.js'
import UiButton from './ui/UiButton.vue'
import UiSlider from './ui/UiSlider.vue'

const props = defineProps<{
  state: ReplayState
  transport: ReplayTransportClass | null
}>()

// The scrubber's value is the transport index; setting it (drag or keyboard) seeks the transport.
const scrubIndex = computed({
  get: () => props.state.index,
  set: (i) => props.transport?.seek(i),
})
</script>

<template>
  <div class="replay-transport">
    <UiButton
      variant="secondary"
      size="tight"
      aria-label="Step back"
      :disabled="state.index === 0"
      @click="transport?.stepBack()"
    >
      <span aria-hidden="true">←</span>
    </UiButton>
    <UiButton size="tight" @click="transport?.toggle()">
      {{ state.playing ? 'Pause' : 'Play' }}
    </UiButton>
    <UiButton
      variant="secondary"
      size="tight"
      aria-label="Step forward"
      :disabled="state.index >= state.total - 1"
      @click="transport?.stepForward()"
    >
      <span aria-hidden="true">→</span>
    </UiButton>
    <div class="scrubber">
      <UiSlider
        v-model="scrubIndex"
        :max="Math.max(0, state.total - 1)"
        label="Replay position"
      />
    </div>
    <span class="replay-position">
      tick {{ state.tick ?? 0 }} ·
      {{ state.index + 1 }}/{{ state.total }}
    </span>
  </div>
</template>

<style scoped>
.replay-transport {
  display: contents;
}

.scrubber {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  min-height: 44px;
}

.replay-position {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  white-space: nowrap;
}
</style>
