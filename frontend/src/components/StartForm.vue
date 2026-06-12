<!--
  The small start form the environment page's Play and Watch entry points open: an optional seed (for
  reproducible runs) and, for a human session, the human-slot timeout control. The control's meaning
  follows the pace interval, per interaction.md:

  - Paced environment (Flappy Bird): the per-step deadline IS the pace interval — a step with no input
    gets the noop. The form states this; an entered value is still sent as an override (the Stage 3 API
    resolves and forwards it), which is the override seam even though the paced loop never consults it.
  - Unpaced environment (a later turn-based game): the same control is the move clock, prefilled from
    the metadata's human_timeout_ms and overridable.

  It emits `submit` with the resolved values and `cancel`; the environment page owns navigation.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { ref } from 'vue'

const props = defineProps<{ meta: EnvironmentMeta; mode: 'human' | 'scripted' }>()
const emit = defineEmits<{
  submit: [{ seed?: number; humanSlotTimeoutMs?: number }]
  cancel: []
}>()

// Vue casts a `type="number"` input to a number (and leaves an empty field as the empty string), so
// these hold `string | number`.
const seed = ref<string | number>('')
// Prefill an unpaced environment's move clock from its metadata; a paced one starts blank (the pace
// interval is the implicit default).
const timeout = ref<string | number>(
  props.meta.pace_interval_ms === null && props.meta.human_timeout_ms !== null
    ? props.meta.human_timeout_ms
    : '',
)

const isPaced = props.meta.pace_interval_ms !== null

/** A blank field is "no value"; anything else parses to a finite number or is dropped. */
function optionalNumber(raw: string | number): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined
  }
  if (raw.trim() === '') {
    return undefined
  }
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function onSubmit(): void {
  emit('submit', {
    seed: optionalNumber(seed.value),
    humanSlotTimeoutMs: optionalNumber(timeout.value),
  })
}
</script>

<template>
  <form class="start-form" @submit.prevent="onSubmit">
    <h3>{{ mode === 'human' ? 'Play' : 'Watch' }} {{ meta.display_name }}</h3>

    <label class="field">
      <span>Seed (optional)</span>
      <input v-model="seed" type="number" min="0" placeholder="random" />
    </label>

    <label v-if="mode === 'human'" class="field">
      <span>{{ isPaced ? 'Per-step input window (ms)' : 'Move time limit (ms)' }}</span>
      <input
        v-model="timeout"
        type="number"
        min="0"
        :placeholder="isPaced ? String(meta.pace_interval_ms) : 'default'"
      />
      <small class="hint">
        <template v-if="isPaced">
          This is a paced game: each step has a {{ meta.pace_interval_ms }} ms input window
          ({{ Math.round(1000 / (meta.pace_interval_ms ?? 1)) }} steps/second). A step with no input
          flies straight. Leave blank to use the default.
        </template>
        <template v-else>
          How long you may take to act each turn. Leave blank for the environment default.
        </template>
      </small>
    </label>

    <div class="start-form-actions">
      <button type="submit">{{ mode === 'human' ? 'Start playing' : 'Start watching' }}</button>
      <button type="button" class="secondary" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>
