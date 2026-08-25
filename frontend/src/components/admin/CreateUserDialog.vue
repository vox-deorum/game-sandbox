<!--
  The create-user dialog (Stage 12.4): the manual-account path for a student with no GitHub account, a
  fixed name/email/password/role. Self-contained; emits `done` on success so the page jumps to page 1
  and refetches. There is no target, so a simple busy guard is enough re-entrancy protection.
-->
<script setup lang="ts">
import { ref, watch } from 'vue'

import { authClient } from '../../auth.js'
import UiButton from '../ui/UiButton.vue'
import UiDialog from '../ui/UiDialog.vue'
import UiField from '../ui/UiField.vue'
import UiInput from '../ui/UiInput.vue'
import UiSelect from '../ui/UiSelect.vue'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ done: [] }>()

const name = ref('')
const email = ref('')
const password = ref('')
const role = ref<'user' | 'guest' | 'admin'>('user')
const busy = ref(false)
const error = ref<string | null>(null)

watch(open, (isOpen) => {
  if (isOpen) {
    name.value = ''
    email.value = ''
    password.value = ''
    role.value = 'user'
    error.value = null
  }
})

async function onConfirm(): Promise<void> {
  if (busy.value) {
    return
  }
  busy.value = true
  error.value = null
  try {
    const { error: err } = await authClient.admin.createUser({
      name: name.value,
      email: email.value,
      password: password.value,
      // The backend's VALID_ROLES includes `guest`; Better Auth's client type only lists the built-in
      // roles, so the guest option is carried here as a widened role value.
      role: role.value as 'user' | 'admin',
    })
    if (err) {
      error.value = err.message ?? 'Could not create this user.'
      return
    }
    open.value = false
    emit('done')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiDialog
    v-model:open="open"
    title="Create user"
    description="For a student with no GitHub account: a fixed email and password."
  >
    <form class="create-form" @submit.prevent="onConfirm">
      <UiField label="Name">
        <template #default="{ id, describedby }">
          <UiInput :id="id" v-model="name" type="text" :aria-describedby="describedby" />
        </template>
      </UiField>
      <UiField label="Email">
        <template #default="{ id, describedby }">
          <UiInput
            :id="id"
            v-model="email"
            type="email"
            autocomplete="email"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>
      <UiField label="Password">
        <template #default="{ id, describedby }">
          <UiInput
            :id="id"
            v-model="password"
            type="password"
            autocomplete="new-password"
            :aria-describedby="describedby"
          />
        </template>
      </UiField>
      <UiField label="Role">
        <template #default="{ id, describedby }">
          <UiSelect :id="id" v-model="role" :aria-describedby="describedby">
            <option value="user">User</option>
            <option value="guest">Guest</option>
            <option value="admin">Admin</option>
          </UiSelect>
        </template>
      </UiField>
      <p v-if="error !== null" class="dialog-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <UiButton type="submit" :loading="busy">Create</UiButton>
        <UiButton type="button" variant="ghost" @click="open = false">Cancel</UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.create-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

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
