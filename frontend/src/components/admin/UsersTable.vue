<!--
  The roster table (Stage 12.4): one row per account with its derived status, ban badge, created date,
  and the row actions (approve, promote / demote, ban / unban, reset password), plus the pager. It is
  presentational — every action is emitted for the page to run. Approve and unban run inline, so the
  table owns their row-level busy display: a click on one row's action disables that action across
  every row while it is in flight, rather than silently swallowing a second click. Promote, demote,
  ban, and reset password only open a confirmation dialog, whose busy state the dialog itself owns.
-->
<script setup lang="ts">
import { deriveStatus, type UserStatus } from '@game-sandbox/schema/accounts'

import { formatDate } from '../../lib/format.js'
import type { RosterUser } from '../../lib/roster.js'
import UiBadge from '../ui/UiBadge.vue'
import UiButton from '../ui/UiButton.vue'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

const props = defineProps<{
  rows: RosterUser[]
  total: number
  offset: number
  pageSize: number
  loading: boolean
  /** The id of the row whose approve/unban action is in flight, so its button shows a spinner. */
  approveBusyId: string | null
  unbanBusyId: string | null
  /** The signed-in operator's own id, so self-targeting actions are disabled. */
  selfId: string | null
}>()

const emit = defineEmits<{
  approve: [row: RosterUser]
  /** Promote (`admin`) or demote (`user`); the page confirms through RoleChangeDialog before acting. */
  changeRole: [row: RosterUser, role: 'user' | 'admin']
  unban: [row: RosterUser]
  ban: [row: RosterUser]
  reset: [row: RosterUser]
  prev: []
  next: []
}>()

function statusOf(row: RosterUser): UserStatus {
  return deriveStatus(row.role)
}

function statusTone(status: UserStatus): 'success' | 'neutral' | 'warning' {
  if (status === 'admin') {
    return 'success'
  }
  return status === 'normal' ? 'neutral' : 'warning'
}

function isSelf(row: RosterUser): boolean {
  return row.id === props.selfId
}

/** Better Auth revives `createdAt` to a `Date`; format it the way the other admin tables do. */
function createdText(row: RosterUser): string {
  return formatDate(row.createdAt) ?? '—'
}
</script>

<template>
  <table class="users-table">
    <thead>
      <tr>
        <th scope="col">Name</th>
        <th scope="col">Email</th>
        <th scope="col">Status</th>
        <th scope="col">Created</th>
        <th scope="col">Actions</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="row.id">
        <td>{{ row.name }}</td>
        <td>{{ row.email }}</td>
        <td>
          <UiStatusBadge :tone="statusTone(statusOf(row))" :label="statusOf(row)" />
          <UiBadge v-if="row.banned === true" variant="danger">Banned</UiBadge>
        </td>
        <td>{{ createdText(row) }}</td>
        <td class="users-actions">
          <UiButton
            v-if="statusOf(row) === 'pending'"
            size="tight"
            variant="secondary"
            :disabled="isSelf(row) || approveBusyId !== null"
            :loading="approveBusyId === row.id"
            @click="emit('approve', row)"
          >
            Approve
          </UiButton>
          <UiButton
            v-else-if="statusOf(row) === 'normal'"
            size="tight"
            variant="secondary"
            :disabled="isSelf(row)"
            @click="emit('changeRole', row, 'admin')"
          >
            Promote
          </UiButton>
          <UiButton
            v-else
            size="tight"
            variant="secondary"
            :disabled="isSelf(row)"
            @click="emit('changeRole', row, 'user')"
          >
            Demote
          </UiButton>

          <UiButton
            v-if="row.banned === true"
            size="tight"
            variant="secondary"
            :disabled="isSelf(row) || unbanBusyId !== null"
            :loading="unbanBusyId === row.id"
            @click="emit('unban', row)"
          >
            Unban
          </UiButton>
          <UiButton
            v-else
            size="tight"
            variant="danger"
            :disabled="isSelf(row)"
            @click="emit('ban', row)"
          >
            Ban
          </UiButton>

          <UiButton size="tight" variant="ghost" :disabled="isSelf(row)" @click="emit('reset', row)">
            Reset password
          </UiButton>
        </td>
      </tr>
    </tbody>
  </table>

  <div class="users-pager">
    <span class="users-range">
      {{
        total === 0
          ? '0–0 of 0'
          : `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}`
      }}
    </span>
    <div class="users-pager-buttons">
      <UiButton
        variant="secondary"
        size="tight"
        :disabled="loading || offset <= 0"
        @click="emit('prev')"
      >
        Prev
      </UiButton>
      <UiButton
        variant="secondary"
        size="tight"
        :disabled="loading || offset + pageSize >= total"
        @click="emit('next')"
      >
        Next
      </UiButton>
    </div>
  </div>
</template>

<style scoped>
.users-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.users-table th,
.users-table td {
  text-align: left;
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}

.users-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.users-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.users-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.users-range {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.users-pager-buttons {
  display: flex;
  gap: var(--space-2);
}
</style>
