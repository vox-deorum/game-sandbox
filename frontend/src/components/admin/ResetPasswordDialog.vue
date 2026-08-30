<!--
  The reset-password dialog (Stage 12.4). Self-contained: it owns the password field and the request,
  emits `done` on success so the page refetches. Shares the same in-flight/staleness guard as the ban
  dialog (useTargetedAction), so a cancel + reopen can never fire a duplicate reset.
-->
<script setup lang="ts">
import { ref, watch } from 'vue'

import { authClient } from '../../auth.js'
import { useTargetedAction } from '../../composables/useTargetedAction.js'
import type { RosterUser } from '../../lib/roster.js'
import UiConfirmDialog from '../ui/UiConfirmDialog.vue'
import UiField from '../ui/UiField.vue'
import UiInput from '../ui/UiInput.vue'

const props = defineProps<{ target: RosterUser | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [] }>()

const newPassword = ref('')
const { busy, error, beginFor, confirm } = useTargetedAction('Could not reset this password.')

watch(open, (isOpen) => {
  if (isOpen) {
    newPassword.value = ''
    beginFor(props.target?.id ?? null)
  }
})

async function onConfirm(): Promise<void> {
  const target = props.target
  if (target === null) {
    return
  }
  const outcome = await confirm(
    target.id,
    () => authClient.admin.setUserPassword({ userId: target.id, newPassword: newPassword.value }),
    () => props.target?.id === target.id,
  )
  if (outcome === 'success') {
    if (props.target?.id === target.id) {
      open.value = false
    }
    emit('done')
  }
}
</script>

<template>
  <UiConfirmDialog
    v-model:open="open"
    title="Reset password"
    :description="target !== null ? `Set a new password for ${target.name}.` : undefined"
    confirm-label="Save"
    :confirm-loading="busy"
    cancel-label="Cancel"
    :error="error"
    @confirm="onConfirm"
  >
    <UiField label="New password">
      <template #default="{ id, describedby }">
        <UiInput
          :id="id"
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          :aria-describedby="describedby"
        />
      </template>
    </UiField>
  </UiConfirmDialog>
</template>
