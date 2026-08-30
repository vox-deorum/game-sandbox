<script setup lang="ts">
import UiButton from './UiButton.vue'
import UiDialog from './UiDialog.vue'
import UiDialogActions from './UiDialogActions.vue'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const open = defineModel<boolean>('open', { required: true })

const props = withDefaults(
  defineProps<{
    title: string
    description?: string
    confirmLabel: string
    confirmVariant?: ButtonVariant
    confirmLoading?: boolean
    confirmDisabled?: boolean
    secondaryLabel?: string
    secondaryVariant?: ButtonVariant
    secondaryLoading?: boolean
    secondaryDisabled?: boolean
    cancelLabel?: string
    cancelDisabled?: boolean
    error?: string | null
    dismissible?: boolean
  }>(),
  {
    description: undefined,
    confirmVariant: 'primary',
    confirmLoading: false,
    confirmDisabled: false,
    secondaryLabel: undefined,
    secondaryVariant: 'secondary',
    secondaryLoading: false,
    secondaryDisabled: false,
    cancelLabel: undefined,
    cancelDisabled: false,
    error: null,
    dismissible: true,
  },
)

const emit = defineEmits<{
  confirm: []
  secondary: []
  cancel: []
}>()

function confirm(): void {
  if (!props.confirmDisabled && !props.confirmLoading) emit('confirm')
}

function secondary(): void {
  if (
    props.secondaryLabel !== undefined &&
    !props.secondaryDisabled &&
    !props.secondaryLoading
  ) {
    emit('secondary')
  }
}

/** Cancel always closes the dialog itself; the emit is for callers with extra cleanup. */
function cancel(): void {
  if (props.cancelDisabled) return
  open.value = false
  emit('cancel')
}
</script>

<template>
  <UiDialog
    :open="open"
    :title="title"
    :description="description"
    :dismissible="dismissible"
    @update:open="(value) => (open = value)"
  >
    <slot />
    <p v-if="error != null" class="ui-confirm-dialog-error" role="alert">{{ error }}</p>
    <UiDialogActions>
      <UiButton
        :variant="confirmVariant"
        :loading="confirmLoading"
        :disabled="confirmDisabled"
        @click="confirm"
      >
        {{ confirmLabel }}
      </UiButton>
      <UiButton
        v-if="secondaryLabel !== undefined"
        :variant="secondaryVariant"
        :loading="secondaryLoading"
        :disabled="secondaryDisabled"
        @click="secondary"
      >
        {{ secondaryLabel }}
      </UiButton>
      <UiButton
        v-if="cancelLabel !== undefined"
        variant="ghost"
        :disabled="cancelDisabled"
        @click="cancel"
      >
        {{ cancelLabel }}
      </UiButton>
    </UiDialogActions>
  </UiDialog>
</template>

<style scoped>
.ui-confirm-dialog-error {
  margin: var(--space-2) 0 0;
  color: var(--color-danger);
  font-size: var(--text-sm);
}
</style>
