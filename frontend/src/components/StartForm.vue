<!--
  The start form the environment page's Play entry point opens inside a UiDialog: an optional seed
  (for reproducible runs) and the human timeout control. Watch starts through WatchAgentPicker
  instead, so this form is human-play only. The timeout control's meaning follows the pace interval,
  per interaction.md:

  - Sequential paced environment (Flappy Bird): the per-step deadline is the pace interval. A step with no input
    gets the noop. The hint states this; an entered value is still sent as an override (the Stage 3 API
    resolves and forwards it), which is the override seam even though the paced loop never consults it.
  - Simultaneous environment: the pace interval is the input window. It has no separate human-timeout
    override, so the form displays the interval without an editable control.
  - Unpaced environment (a later turn-based game): the same control is the move clock, prefilled from
    the metadata's human_timeout_ms and overridable.

  It emits `submit` with the resolved values and `cancel`; the environment page owns navigation and the
  dialog title.
-->
<script setup lang="ts">
import type { EnvironmentMeta, ParameterValue } from '@game-sandbox/schema/environment'
import { computed, ref } from 'vue'

import type { StartPayload } from '../api/client.js'
import { optionalNumber } from '../lib/forms.js'
import { initializeParameters, validateParameters } from '../lib/parameters.js'
import ParameterFields from './ParameterFields.vue'
import SimultaneousWindowField from './SimultaneousWindowField.vue'
import UiButton from './ui/UiButton.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'

const props = defineProps<{
  meta: EnvironmentMeta
  seasonId: string
  parameters: Record<string, ParameterValue>
}>()
const emit = defineEmits<{
  /** Everything the start payload carries except the seats, which this form fills with the lone human. */
  submit: [Omit<StartPayload, 'seats'>]
  cancel: []
}>()

const isPaced = props.meta.pace_interval_ms !== null
const isSimultaneous = props.meta.stepping === 'simultaneous'

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
const parameters = ref(initializeParameters(props.meta.parameters, props.parameters))
const parametersValid = ref(true)

const timeoutLabel = computed(() => (isPaced ? 'Per-step input window (ms)' : 'Move time limit (ms)'))
const timeoutHint = computed(() =>
  isPaced
    ? `Each step has a ${props.meta.pace_interval_ms} ms input window ` +
      `(${Math.round(1000 / (props.meta.pace_interval_ms ?? 1))} steps/second). A step with no input ` +
      'flies straight. Leave blank to use the default.'
    : 'How long you may take to act each turn. Leave blank for the environment default.',
)

function onSubmit(): void {
  const checked = validateParameters(props.meta.parameters, parameters.value)
  if (Object.keys(checked.errors).length > 0) return
  emit('submit', {
    seasonId: props.seasonId,
    parameters: checked.values,
    seed: optionalNumber(seed.value),
    humanTimeoutMs: isSimultaneous ? undefined : optionalNumber(timeout.value),
  })
}
</script>

<template>
  <form class="start-form" @submit.prevent="onSubmit">
    <ParameterFields
      v-model="parameters"
      :declarations="meta.parameters"
      :presets="meta.presets"
      @validity="parametersValid = $event"
    />
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

    <SimultaneousWindowField v-if="isSimultaneous" :pace-interval-ms="meta.pace_interval_ms" />

    <UiField v-else :label="timeoutLabel" :hint="timeoutHint">
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
      <UiButton type="submit" :disabled="!parametersValid">Start playing</UiButton>
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
