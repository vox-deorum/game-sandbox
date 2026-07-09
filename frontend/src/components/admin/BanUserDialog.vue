<!--
  The ban confirmation dialog (Stage 12.4). Self-contained: it owns the reason field and the request,
  emits `done` on a successful ban so the page refetches. Ban is the account retirement path (there is
  no delete), so this revokes the target's sessions and blocks sign-in. Cancel + reopen while a request
  is still in flight can never fire a duplicate — see useTargetedAction.
-->
<script setup lang="ts">
import { ref, watch } from 'vue'

import { authClient } from '../../auth.js'
import { useTargetedAction } from '../../composables/useTargetedAction.js'
import type { RosterUser } from '../../lib/roster.js'
import UiButton from '../ui/UiButton.vue'
import UiDialog from '../ui/UiDialog.vue'
import UiField from '../ui/UiField.vue'
import UiInput from '../ui/UiInput.vue'

const props = defineProps<{ target: RosterUser | null }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [] }>()

const reason = ref('')
const { busy, error, beginFor, confirm } = useTargetedAction('Could not ban this user.')

watch(open, (isOpen) => {
  if (isOpen) {
    reason.value = ''
    beginFor(props.target?.id ?? null)
  }
})

async function onConfirm(): Promise<void> {
  const target = props.target
  if (target === null) {
    return
  }
  const trimmed = reason.value.trim()
  const outcome = await confirm(
    target.id,
    () =>
      authClient.admin.banUser({
        userId: target.id,
        ...(trimmed !== '' ? { banReason: trimmed } : {}),
      }),
    () => props.target?.id === target.id,
  )
  if (outcome === 'success') {
    // Close only if this row is still the one showing; always refetch the roster.
    if (props.target?.id === target.id) {
      open.value = false
    }
    emit('done')
  }
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    title="Ban user"
    :description="
      target !== null
        ? `Ban ${target.name}? This revokes their sessions and blocks sign-in.`
        : undefined
    "
  >
    <UiField label="Reason (optional)">
      <template #default="{ id, describedby }">
        <UiInput :id="id" v-model="reason" type="text" :aria-describedby="describedby" />
      </template>
    </UiField>
    <p v-if="error !== null" class="dialog-error" role="alert">{{ error }}</p>
    <div class="dialog-actions">
      <UiButton variant="danger" :loading="busy" @click="onConfirm">Ban</UiButton>
      <UiButton variant="ghost" @click="open = false">Cancel</UiButton>
    </div>
  </UiDialog>
</template>

<style scoped>
.dialog-error {
  margin: var(--space-2) 0 0;
  color: var(--color-danger);
  font-size: var(--text-sm);
}

.dialog-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-4);
}
</style>
