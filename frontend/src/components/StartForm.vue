<!--
  The start form the environment page's Play entry point opens inside a UiDialog: an optional seed
  (for reproducible runs) and the human-slot timeout control. Watch starts through WatchAgentPicker
  instead, so this form is human-play only. The timeout control's meaning follows the pace interval,
  per interaction.md:

  - Paced environment (Flappy Bird): the per-step deadline IS the pace interval — a step with no input
    gets the noop. The hint states this; an entered value is still sent as an override (the Stage 3 API
    resolves and forwards it), which is the override seam even though the paced loop never consults it.
  - Unpaced environment (a later turn-based game): the same control is the move clock, prefilled from
    the metadata's human_timeout_ms and overridable.

  It emits `submit` with the resolved values and `cancel`; the environment page owns navigation and the
  dialog title.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, ref } from 'vue'

import UiButton from './ui/UiButton.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'

const props = defineProps<{ meta: EnvironmentMeta }>()
const emit = defineEmits<{
  submit: [{ seed?: number; humanSlotTimeoutMs?: number }]
  cancel: []
}>()

const isPaced = props.meta.pace_interval_ms !== null

// Vue casts a `type="number"` input to a number (and leaves an empty field the empty string), so
// these hold `string | number`; the optional-number parse below turns a blank into "no value".
const seed = ref<string | number>('')
// Prefill an unpaced environment's move clock from its metadata; a paced one starts blank (the pace
// interval is the implicit default).
const timeout = ref<string | number>(
  props.meta.pace_interval_ms === null && props.meta.human_timeout_ms !== null
    ? props.meta.human_timeout_ms
    : '',
)

const timeoutLabel = computed(() => (isPaced ? 'Per-step input window (ms)' : 'Move time limit (ms)'))
const timeoutHint = computed(() =>
  isPaced
    ? `Each step has a ${props.meta.pace_interval_ms} ms input window ` +
      `(${Math.round(1000 / (props.meta.pace_interval_ms ?? 1))} steps/second). A step with no input ` +
      'flies straight. Leave blank to use the default.'
    : 'How long you may take to act each turn. Leave blank for the environment default.',
)

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
    <UiField label="Seed (optional)" hint="Leave blank for a random seed.">
      <template #default="{ id, describedby }">
        <UiInput
          :id="id"
          v-model="seed"
          type="number"
          min="0"
          placeholder="random"
          :aria-describedby="describedby"
        />
      </template>
    </UiField>

    <UiField :label="timeoutLabel" :hint="timeoutHint">
      <template #default="{ id, describedby }">
        <UiInput
          :id="id"
          v-model="timeout"
          type="number"
          min="0"
          :placeholder="isPaced ? String(meta.pace_interval_ms) : 'default'"
          :aria-describedby="describedby"
        />
      </template>
    </UiField>

    <div class="start-form-actions">
      <UiButton type="submit">Start playing</UiButton>
      <UiButton type="button" variant="ghost" @click="emit('cancel')">Cancel</UiButton>
    </div>
  </form>
</template>

<style scoped>
.start-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.start-form-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
</style>
