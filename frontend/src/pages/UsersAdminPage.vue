<!--
  The operator roster page (Stage 12.4) at /admin/users: lists, searches, and pages every account
  through Better Auth's admin plugin, gated by `isAdmin(me)` the way AdminConsolePage self-gates — the
  plugin's server-side custom-role permission check is the real authority, this is just avoiding dead
  controls for a non-operator who reaches the route.

  This is the one page that drives `authClient.admin.*` directly rather than a typed wrapper in
  api/client.ts: the plugin already exposes a gated, typed API, so a proxy route would just re-implement
  it. Status tabs and the search box are independent list-users params (one filterField per request,
  search fields are separate), so both can be sent together. There is deliberately no delete action:
  ban is the retirement path, because submissions, recordings, ratings, and placements key on the user
  id and a removed user would orphan that attribution.
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'

import { authClient } from '../auth.js'
import UiBadge from '../components/ui/UiBadge.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiDialog from '../components/ui/UiDialog.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiField from '../components/ui/UiField.vue'
import UiInput from '../components/ui/UiInput.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiStatusBadge from '../components/ui/UiStatusBadge.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import { formatDate } from '../lib/format.js'
import { isAdmin, useMe, userId } from '../me.js'

type Access = 'loading' | 'denied' | 'ready'
const access = ref<Access>('loading')
const me = useMe()

// Derived directly from the real client call so a row always has exactly the fields the plugin
// returns, with no hand-maintained shape to drift from it (this is the one page that touches
// `authClient.admin`, so there is no existing wrapper type to reuse).
type ListUsersResult = Awaited<ReturnType<typeof authClient.admin.listUsers>>
type RosterUser = Extract<ListUsersResult, { error: null }>['data']['users'][number]

type StatusTabKey = 'all' | 'pending' | 'normal' | 'admins' | 'banned'
const TABS: { key: StatusTabKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'normal', label: 'Normal' },
  { key: 'admins', label: 'Admins' },
  { key: 'banned', label: 'Banned' },
]
const PAGE_SIZE = 50
// The search box fires on every keystroke; wait for a pause before sending it.
const SEARCH_DEBOUNCE_MS = 250

const activeTab = ref<StatusTabKey>('all')
const searchValue = ref('')
const searchField = ref<'email' | 'name'>('email')
const offset = ref(0)

const rows = ref<RosterUser[]>([])
const total = ref(0)
const loading = ref(false)
const listError = ref<string | null>(null)
// A row action's failure (approve/promote/ban/...), shown near the table without disturbing the roster
// already on screen.
const actionError = ref<string | null>(null)

type RoleStatus = 'pending' | 'normal' | 'admin'

/**
 * The role-derived status for a roster row, mirroring the backend's `deriveStatus` precedence exactly:
 * any `admin` token in the comma-split role wins, else any `user` token is `normal`, else `pending`. An
 * unknown or missing role fails closed to `pending`, so an imported or corrupted row never reads as
 * more privileged than it is in the All view.
 */
function roleStatus(role: string | null | undefined): RoleStatus {
  if (role === null || role === undefined) {
    return 'pending'
  }
  const tokens = role.split(',').map((token) => token.trim())
  if (tokens.includes('admin')) {
    return 'admin'
  }
  if (tokens.includes('user')) {
    return 'normal'
  }
  return 'pending'
}

function statusTone(status: RoleStatus): 'success' | 'neutral' | 'warning' {
  if (status === 'admin') {
    return 'success'
  }
  return status === 'normal' ? 'neutral' : 'warning'
}

/** The created date the way the other admin tables format one (see SeasonSubmissions.vue). */
function createdText(row: RosterUser): string {
  return formatDate(String(row.createdAt)) ?? '—'
}

function isSelf(row: RosterUser): boolean {
  return row.id === userId(me.me)
}

/** The one `list-users` filter each status tab maps to; All applies none. */
function tabFilter(tab: StatusTabKey): { field: string; value: string | boolean } | null {
  switch (tab) {
    case 'all':
      return null
    case 'pending':
      return { field: 'role', value: 'pending' }
    case 'normal':
      return { field: 'role', value: 'user' }
    case 'admins':
      return { field: 'role', value: 'admin' }
    case 'banned':
      return { field: 'banned', value: true }
  }
}

// A monotonically increasing id for the in-flight `load()` call, so a response that comes back
// after a newer request has already started (the search debounce still lets a click race an
// older keystroke's fetch, and a tab/pager click can race a slow response of its own) can be told
// apart from the one whose data should actually land. Only the call holding the current value when
// its response arrives is allowed to write anything — including its own error handling.
let latestRequestId = 0

async function load(): Promise<void> {
  const requestId = ++latestRequestId
  loading.value = true
  listError.value = null
  try {
    const filter = tabFilter(activeTab.value)
    const trimmedSearch = searchValue.value.trim()
    const { data, error } = await authClient.admin.listUsers({
      query: {
        limit: PAGE_SIZE,
        offset: offset.value,
        ...(trimmedSearch !== ''
          ? {
              searchValue: trimmedSearch,
              searchField: searchField.value,
              searchOperator: 'contains' as const,
            }
          : {}),
        ...(filter !== null
          ? { filterField: filter.field, filterValue: filter.value, filterOperator: 'eq' as const }
          : {}),
      },
    })
    if (requestId !== latestRequestId) {
      // A newer load() has since started; this response is stale and must not touch state that
      // the newer call already owns (or will own once it resolves).
      return
    }
    if (error) {
      listError.value = error.message ?? 'Could not load users.'
      rows.value = []
      total.value = 0
      return
    }
    rows.value = data.users
    total.value = data.total
    // The current page can empty out from under us — e.g. approving the sole row on the last
    // page drops `total` below `offset`. Snap back to the real last page and reload once rather
    // than stranding the view on an out-of-range page (that reload lands on a non-empty page, or
    // on total === 0, so it cannot recurse further).
    if (rows.value.length === 0 && total.value > 0 && offset.value >= total.value) {
      offset.value = Math.floor((total.value - 1) / PAGE_SIZE) * PAGE_SIZE
      await load()
    }
  } finally {
    if (requestId === latestRequestId) {
      loading.value = false
    }
  }
}

// Switching tabs or the search field always starts back at page 1 — the old offset would
// otherwise page into a differently-filtered result set. These are discrete clicks/selections,
// not a keystroke stream, so they fire immediately; load()'s request-token guard above keeps any
// still-in-flight response race-safe.
watch([activeTab, searchField], () => {
  offset.value = 0
  void load()
})

// The search box fires on every keystroke; debounce it so typing doesn't send one request per
// character. A still-in-flight request from a superseded keystroke is handled by load()'s token
// guard regardless, but there is no reason to send it in the first place.
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
watch(searchValue, () => {
  if (searchDebounceTimer !== null) {
    clearTimeout(searchDebounceTimer)
  }
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null
    offset.value = 0
    void load()
  }, SEARCH_DEBOUNCE_MS)
})

onUnmounted(() => {
  if (searchDebounceTimer !== null) {
    clearTimeout(searchDebounceTimer)
  }
})

function prevPage(): void {
  if (loading.value || offset.value <= 0) {
    return
  }
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
  void load()
}

function nextPage(): void {
  if (loading.value || offset.value + PAGE_SIZE >= total.value) {
    return
  }
  offset.value += PAGE_SIZE
  void load()
}

// ---- Row actions: approve / promote / demote / unban call straight through; ban and reset password
// open a small dialog first. Every action refetches the current page on success.

const roleBusyId = ref<string | null>(null)
const unbanBusyId = ref<string | null>(null)

async function runRoleAction(row: RosterUser, role: 'user' | 'admin'): Promise<void> {
  if (isSelf(row) || roleBusyId.value !== null) {
    return
  }
  roleBusyId.value = row.id
  actionError.value = null
  try {
    const { error } = await authClient.admin.setRole({ userId: row.id, role })
    if (error) {
      actionError.value = error.message ?? 'Could not update that role.'
      return
    }
    await load()
  } finally {
    roleBusyId.value = null
  }
}

async function runUnban(row: RosterUser): Promise<void> {
  if (isSelf(row) || unbanBusyId.value !== null) {
    return
  }
  unbanBusyId.value = row.id
  actionError.value = null
  try {
    const { error } = await authClient.admin.unbanUser({ userId: row.id })
    if (error) {
      actionError.value = error.message ?? 'Could not unban this user.'
      return
    }
    await load()
  } finally {
    unbanBusyId.value = null
  }
}

const banTarget = ref<RosterUser | null>(null)
const banDialogOpen = ref(false)
const banReason = ref('')
const banBusy = ref(false)
const banError = ref<string | null>(null)

function openBanDialog(row: RosterUser): void {
  banTarget.value = row
  banReason.value = ''
  // A prior ban for a different row may still be in flight (its dialog can be cancelled without
  // waiting on it — see confirmBan); a freshly opened dialog must never inherit that stale busy state.
  banBusy.value = false
  banError.value = null
  banDialogOpen.value = true
}

async function confirmBan(): Promise<void> {
  if (banTarget.value === null || banBusy.value) {
    return
  }
  // Captured before the await: the dialog can be cancelled and reopened for a different row while this
  // request is still in flight, so its completion must not close or paint into whatever dialog happens
  // to be open when it resolves — only into this row's own, if it is still the one showing.
  const targetId = banTarget.value.id
  banBusy.value = true
  banError.value = null
  try {
    const reason = banReason.value.trim()
    const { error } = await authClient.admin.banUser({
      userId: targetId,
      ...(reason !== '' ? { banReason: reason } : {}),
    })
    const stillTarget = banTarget.value?.id === targetId
    if (error) {
      if (stillTarget) {
        banError.value = error.message ?? 'Could not ban this user.'
      }
      return
    }
    if (stillTarget) {
      banDialogOpen.value = false
    }
    // A successful ban always refetches the roster, regardless of which dialog is now open.
    await load()
  } finally {
    if (banTarget.value?.id === targetId) {
      banBusy.value = false
    }
  }
}

const resetTarget = ref<RosterUser | null>(null)
const resetDialogOpen = ref(false)
const newPassword = ref('')
const resetBusy = ref(false)
const resetError = ref<string | null>(null)

function openResetDialog(row: RosterUser): void {
  resetTarget.value = row
  newPassword.value = ''
  // A prior reset for a different row may still be in flight (its dialog can be cancelled without
  // waiting on it — see confirmReset); a freshly opened dialog must never inherit that stale busy state.
  resetBusy.value = false
  resetError.value = null
  resetDialogOpen.value = true
}

async function confirmReset(): Promise<void> {
  if (resetTarget.value === null || resetBusy.value) {
    return
  }
  // Captured before the await: the dialog can be cancelled and reopened for a different row while this
  // request is still in flight, so its completion must not close or paint into whatever dialog happens
  // to be open when it resolves — only into this row's own, if it is still the one showing.
  const targetId = resetTarget.value.id
  resetBusy.value = true
  resetError.value = null
  try {
    const { error } = await authClient.admin.setUserPassword({
      userId: targetId,
      newPassword: newPassword.value,
    })
    const stillTarget = resetTarget.value?.id === targetId
    if (error) {
      if (stillTarget) {
        resetError.value = error.message ?? 'Could not reset this password.'
      }
      return
    }
    if (stillTarget) {
      resetDialogOpen.value = false
    }
    // A successful reset always refetches the roster, regardless of which dialog is now open.
    await load()
  } finally {
    if (resetTarget.value?.id === targetId) {
      resetBusy.value = false
    }
  }
}

// ---- Create-user dialog: the manual-account path for a student with no GitHub account.

const createDialogOpen = ref(false)
const createName = ref('')
const createEmail = ref('')
const createPassword = ref('')
const createRole = ref<'user' | 'admin'>('user')
const createBusy = ref(false)
const createError = ref<string | null>(null)

function openCreateDialog(): void {
  createName.value = ''
  createEmail.value = ''
  createPassword.value = ''
  createRole.value = 'user'
  createError.value = null
  createDialogOpen.value = true
}

async function confirmCreate(): Promise<void> {
  if (createBusy.value) {
    return
  }
  createBusy.value = true
  createError.value = null
  try {
    const { error } = await authClient.admin.createUser({
      name: createName.value,
      email: createEmail.value,
      password: createPassword.value,
      role: createRole.value,
    })
    if (error) {
      createError.value = error.message ?? 'Could not create this user.'
      return
    }
    createDialogOpen.value = false
    offset.value = 0
    await load()
  } finally {
    createBusy.value = false
  }
}

onMounted(async () => {
  // The route is operator-only. Wait for the single /api/me answer, then gate; the backend admin
  // routes enforce the same gate, so a non-operator who forces the URL still gets nothing.
  await me.whenSettled()
  if (!isAdmin(me.me)) {
    access.value = 'denied'
    return
  }
  access.value = 'ready'
  await load()
})
</script>

<template>
  <section class="users-admin">
    <UiEmptyState v-if="access === 'loading'">Checking access…</UiEmptyState>
    <UiEmptyState v-else-if="access === 'denied'" tone="danger">
      User management is limited to operators.
    </UiEmptyState>

    <template v-else>
      <header class="users-header">
        <h1>Users</h1>
        <UiButton @click="openCreateDialog">Create user</UiButton>
      </header>

      <UiTabs v-model="activeTab" class="users-tabs" :tabs="TABS" />

      <div class="users-search">
        <UiInput
          v-model="searchValue"
          type="text"
          placeholder="Search…"
          aria-label="Search users"
        />
        <UiSelect v-model="searchField" aria-label="Search field">
          <option value="email">Email</option>
          <option value="name">Name</option>
        </UiSelect>
      </div>

      <UiEmptyState v-if="listError !== null" tone="danger">{{ listError }}</UiEmptyState>
      <p v-if="actionError !== null" class="users-action-error" role="alert">{{ actionError }}</p>

      <!-- The error notice above stands alone: no table skeleton or "0–0 of 0" pager under it. -->
      <template v-if="listError === null">
        <UiEmptyState v-if="loading && rows.length === 0">Loading users…</UiEmptyState>
        <UiEmptyState v-else-if="!loading && rows.length === 0">No users match.</UiEmptyState>

        <table v-else class="users-table">
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
              <td class="users-status">
                <UiStatusBadge :tone="statusTone(roleStatus(row.role))" :label="roleStatus(row.role)" />
                <UiBadge v-if="row.banned === true" variant="danger">Banned</UiBadge>
              </td>
              <td>{{ createdText(row) }}</td>
              <td class="users-actions">
                <UiButton
                  v-if="roleStatus(row.role) === 'pending'"
                  size="tight"
                  variant="secondary"
                  :disabled="isSelf(row)"
                  :loading="roleBusyId === row.id"
                  @click="runRoleAction(row, 'user')"
                >
                  Approve
                </UiButton>
                <UiButton
                  v-else-if="roleStatus(row.role) === 'normal'"
                  size="tight"
                  variant="secondary"
                  :disabled="isSelf(row)"
                  :loading="roleBusyId === row.id"
                  @click="runRoleAction(row, 'admin')"
                >
                  Promote
                </UiButton>
                <UiButton
                  v-else
                  size="tight"
                  variant="secondary"
                  :disabled="isSelf(row)"
                  :loading="roleBusyId === row.id"
                  @click="runRoleAction(row, 'user')"
                >
                  Demote
                </UiButton>

                <UiButton
                  v-if="row.banned === true"
                  size="tight"
                  variant="secondary"
                  :disabled="isSelf(row)"
                  :loading="unbanBusyId === row.id"
                  @click="runUnban(row)"
                >
                  Unban
                </UiButton>
                <UiButton
                  v-else
                  size="tight"
                  variant="danger"
                  :disabled="isSelf(row)"
                  @click="openBanDialog(row)"
                >
                  Ban
                </UiButton>

                <UiButton
                  size="tight"
                  variant="ghost"
                  :disabled="isSelf(row)"
                  @click="openResetDialog(row)"
                >
                  Reset password
                </UiButton>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="users-pager">
          <span class="users-range">
            {{ total === 0 ? '0–0 of 0' : `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` }}
          </span>
          <div class="users-pager-buttons">
            <UiButton
              variant="secondary"
              size="tight"
              :disabled="loading || offset <= 0"
              @click="prevPage"
            >
              Prev
            </UiButton>
            <UiButton
              variant="secondary"
              size="tight"
              :disabled="loading || offset + PAGE_SIZE >= total"
              @click="nextPage"
            >
              Next
            </UiButton>
          </div>
        </div>
      </template>
    </template>

    <UiDialog
      v-model:open="banDialogOpen"
      title="Ban user"
      :description="banTarget !== null ? `Ban ${banTarget.name}? This revokes their sessions and blocks sign-in.` : undefined"
    >
      <UiField label="Reason (optional)">
        <template #default="{ id, describedby }">
          <UiInput :id="id" v-model="banReason" type="text" :aria-describedby="describedby" />
        </template>
      </UiField>
      <p v-if="banError !== null" class="users-dialog-error" role="alert">{{ banError }}</p>
      <div class="users-dialog-actions">
        <UiButton variant="danger" :loading="banBusy" @click="confirmBan">Ban</UiButton>
        <UiButton variant="ghost" @click="banDialogOpen = false">Cancel</UiButton>
      </div>
    </UiDialog>

    <UiDialog
      v-model:open="resetDialogOpen"
      title="Reset password"
      :description="resetTarget !== null ? `Set a new password for ${resetTarget.name}.` : undefined"
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
      <p v-if="resetError !== null" class="users-dialog-error" role="alert">{{ resetError }}</p>
      <div class="users-dialog-actions">
        <UiButton :loading="resetBusy" @click="confirmReset">Save</UiButton>
        <UiButton variant="ghost" @click="resetDialogOpen = false">Cancel</UiButton>
      </div>
    </UiDialog>

    <UiDialog
      v-model:open="createDialogOpen"
      title="Create user"
      description="For a student with no GitHub account: a fixed email and password."
    >
      <form class="users-create-form" @submit.prevent="confirmCreate">
        <UiField label="Name">
          <template #default="{ id, describedby }">
            <UiInput :id="id" v-model="createName" type="text" :aria-describedby="describedby" />
          </template>
        </UiField>
        <UiField label="Email">
          <template #default="{ id, describedby }">
            <UiInput
              :id="id"
              v-model="createEmail"
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
              v-model="createPassword"
              type="password"
              autocomplete="new-password"
              :aria-describedby="describedby"
            />
          </template>
        </UiField>
        <UiField label="Role">
          <template #default="{ id, describedby }">
            <UiSelect :id="id" v-model="createRole" :aria-describedby="describedby">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </UiSelect>
          </template>
        </UiField>
        <p v-if="createError !== null" class="users-dialog-error" role="alert">{{ createError }}</p>
        <div class="users-dialog-actions">
          <UiButton type="submit" :loading="createBusy">Create</UiButton>
          <UiButton type="button" variant="ghost" @click="createDialogOpen = false">Cancel</UiButton>
        </div>
      </form>
    </UiDialog>
  </section>
</template>

<style scoped>
.users-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.users-header h1 {
  margin: 0;
}

.users-tabs {
  margin-bottom: var(--space-4);
}

.users-search {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  max-width: 28rem;
}

.users-search :deep(.ui-input) {
  flex: 1 1 auto;
}

.users-action-error {
  margin: 0 0 var(--space-3);
  color: var(--color-danger);
  font-size: var(--text-sm);
}

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

.users-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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

.users-dialog-error {
  margin: var(--space-2) 0 0;
  color: var(--color-danger);
  font-size: var(--text-sm);
}

.users-dialog-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.users-create-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
</style>
