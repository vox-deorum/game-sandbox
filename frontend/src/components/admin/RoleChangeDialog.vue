<!--
  The promote/demote confirmation dialog. Granting or revoking operator access is consequential
  enough to ask first — unlike approve, which stays a direct row action — so the table's Promote and
  Demote buttons route here instead of calling set-role inline. Self-contained like BanUserDialog:
  it owns the request and emits `done` on success so the page refetches. Cancel + reopen while a
  request is still in flight can never fire a duplicate — see useTargetedAction.
-->
<script setup lang="ts">
import { computed, watch } from 'vue'

import { authClient } from '../../auth.js'
import { useTargetedAction } from '../../composables/useTargetedAction.js'
import type { RosterUser } from '../../lib/roster.js'
import UiConfirmDialog from '../ui/UiConfirmDialog.vue'

const props = defineProps<{
  target: RosterUser | null
  /** The role confirming applies: `admin` promotes the target, `user` demotes them. */
  role: 'user' | 'admin'
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [] }>()

const { busy, error, beginFor, confirm } = useTargetedAction('Could not update that role.')

watch(open, (isOpen) => {
  if (isOpen) {
    beginFor(props.target?.id ?? null)
  }
})

const verb = computed(() => (props.role === 'admin' ? 'Promote' : 'Demote'))

const description = computed(() => {
  if (props.target === null) {
    return undefined
  }
  return props.role === 'admin'
    ? `Promote ${props.target.name} to admin? They gain every operator control, including this roster.`
    : `Demote ${props.target.name} to a normal member? They lose operator access but keep participating.`
})

async function onConfirm(): Promise<void> {
  const target = props.target
  if (target === null) {
    return
  }
  const role = props.role
  const outcome = await confirm(
    target.id,
    () => authClient.admin.setRole({ userId: target.id, role }),
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
  <UiConfirmDialog
    v-model:open="open"
    :title="`${verb} user`"
    :description="description"
    :confirm-label="verb"
    :confirm-loading="busy"
    cancel-label="Cancel"
    :error="error"
    @confirm="onConfirm"
  />
</template>
