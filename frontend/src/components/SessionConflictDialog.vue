<!--
  The confirmation shown when a session start hits the one-active-session rule. The state and
  behavior come from useSessionStartConflict; this component only fixes the shared copy so every
  start surface shows the identical dialog (see docs/specs/frontend.md). Once the active session is
  gone (ended by a replace attempt whose retry then failed), "Return" disappears and the copy
  switches to plain retry guidance.
-->
<script setup lang="ts">
import UiConfirmDialog from './ui/UiConfirmDialog.vue'

const open = defineModel<boolean>('open', { required: true })

defineProps<{
  /** The live session "Return" navigates to, or null once it no longer exists. */
  activeSessionId: string | null
  replacing: boolean
  error: string | null
}>()

defineEmits<{
  confirm: []
  secondary: []
}>()
</script>

<template>
  <UiConfirmDialog
    v-model:open="open"
    :title="activeSessionId !== null ? 'A session is already running' : 'The active session has ended'"
    :description="
      activeSessionId !== null
        ? 'End the active session to start this new one, or return to the active session.'
        : 'The new session has not started yet. Start new tries again, and closing abandons the request.'
    "
    confirm-label="Start new"
    confirm-variant="danger"
    :confirm-loading="replacing"
    :secondary-label="activeSessionId !== null ? 'Return' : undefined"
    :secondary-disabled="replacing"
    :error="error"
    :dismissible="!replacing"
    @confirm="$emit('confirm')"
    @secondary="$emit('secondary')"
  />
</template>
