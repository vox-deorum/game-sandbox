<script setup lang="ts">
import type { EnvParameter, ParameterValue } from '@game-sandbox/schema/environment'
import { computed, watch } from 'vue'

import { validateParameters, visibleParameters } from '../lib/parameters.js'
import UiCheckboxGroup from './ui/UiCheckboxGroup.vue'
import UiField from './ui/UiField.vue'
import UiInput from './ui/UiInput.vue'
import UiSelect from './ui/UiSelect.vue'

const props = defineProps<{ declarations: readonly EnvParameter[]; disabled?: boolean }>()
const model = defineModel<Record<string, ParameterValue>>({ required: true })
const emit = defineEmits<{ validity: [boolean] }>()
const visible = computed(() => visibleParameters(props.declarations))
const validation = computed(() => validateParameters(props.declarations, model.value))

watch(
  validation,
  (result) => emit('validity', Object.keys(result.errors).length === 0),
  { immediate: true },
)

function update(name: string, value: unknown): void {
  model.value = { ...model.value, [name]: value as ParameterValue }
}

function numericHint(parameter: Extract<EnvParameter, { type: 'int' | 'float' }>): string {
  return `${parameter.description} ${parameter.min}–${parameter.max}.`
}
</script>

<template>
  <div v-if="visible.length > 0" class="parameter-fields">
    <template v-for="parameter in visible" :key="parameter.name">
      <UiField
        v-if="parameter.type === 'int' || parameter.type === 'float' || parameter.type === 'string'"
        :label="parameter.title"
        :hint="parameter.type === 'string' ? parameter.description : numericHint(parameter)"
        :error="validation.errors[parameter.name]"
      >
        <template #default="{ id, describedby, invalid }">
          <UiInput
            :id="id"
            :model-value="model[parameter.name] as string | number"
            :type="parameter.type === 'string' ? 'text' : 'number'"
            :min="parameter.type === 'string' ? undefined : parameter.min"
            :max="parameter.type === 'string' ? undefined : parameter.max"
            :step="parameter.type === 'float' ? 'any' : undefined"
            :invalid="invalid"
            :disabled="disabled"
            :aria-describedby="describedby"
            @update:model-value="(value) => update(parameter.name, parameter.type === 'string' || value === '' ? value : Number(value))"
          />
        </template>
      </UiField>
      <UiField v-else-if="parameter.type === 'bool'" :label="parameter.title" :hint="parameter.description">
        <template #default="{ id, describedby }">
          <UiSelect
            :id="id"
            :model-value="model[parameter.name] === true ? 'on' : 'off'"
            :disabled="disabled"
            :aria-describedby="describedby"
            @update:model-value="(value) => update(parameter.name, value === 'on')"
          >
            <option value="on">On</option><option value="off">Off</option>
          </UiSelect>
        </template>
      </UiField>
      <UiField v-else-if="parameter.type === 'choice'" :label="parameter.title" :hint="parameter.description">
        <template #default="{ id, describedby }">
          <UiSelect :id="id" :model-value="String(model[parameter.name] ?? '')" :disabled="disabled" :aria-describedby="describedby" @update:model-value="(value) => update(parameter.name, value)">
            <option v-for="choice in parameter.choices" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
          </UiSelect>
        </template>
      </UiField>
      <UiCheckboxGroup
        v-else
        :legend="parameter.title"
        :options="parameter.choices"
        :hint="parameter.description"
        :error="validation.errors[parameter.name]"
        :disabled="disabled"
        :model-value="Array.isArray(model[parameter.name]) ? model[parameter.name] as string[] : []"
        @update:model-value="(value) => update(parameter.name, value)"
      />
    </template>
  </div>
</template>

<style scoped>
.parameter-fields { display: flex; flex-direction: column; gap: var(--space-4); }
</style>
