<!--
  The read-only input-window field a simultaneous environment shows in place of an editable human
  timeout: the environment's pace interval, the time a human has to act each tick. StartForm and
  SeatAssignmentDialog both place this behind their own `v-if`/`v-else-if`, so this component owns
  only the label, hint, and disabled-locked-field markup, not when it appears.
-->
<script setup lang="ts">
import { computed } from 'vue'

import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'

const props = defineProps<{
  paceIntervalMs: number | null
}>()

const hint = computed(
  () =>
    `Each simultaneous tick gives you ${props.paceIntervalMs} ms to choose an action. ` +
    'A missing action uses the environment default.',
)
</script>

<template>
  <UiField label="Input window (ms)" :hint="hint">
    <template #default="{ id, describedby }">
      <UiInput :id="id" :model-value="paceIntervalMs ?? ''" disabled :aria-describedby="describedby" />
    </template>
  </UiField>
</template>
