<!--
  The operator roster page (Stage 12.4) at /admin/users: lists, searches, and pages every account
  through Better Auth's admin plugin, gated by `isAdmin(me)` the way AdminConsolePage self-gates — the
  plugin's server-side custom-role permission check is the real authority, this is just avoiding dead
  controls for a non-operator who reaches the route.

  This page drives `authClient.admin.*` directly rather than a typed wrapper in api/client.ts: the
  plugin already exposes a gated, typed API, so a proxy route would just re-implement it. It owns the
  list state (tabs, search, paging) and the two direct row actions (role change, unban); the ban,
  reset-password, and create flows live in their own self-contained dialogs. Status tabs and the search
  box are independent list-users params, so both can be sent together. There is deliberately no delete
  action: ban is the retirement path, because submissions, recordings, ratings, and placements key on
  the user id and a removed user would orphan that attribution.
-->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'

import { authClient } from '../auth.js'
import BanUserDialog from '../components/admin/BanUserDialog.vue'
import CreateUserDialog from '../components/admin/CreateUserDialog.vue'
import ResetPasswordDialog from '../components/admin/ResetPasswordDialog.vue'
import UsersTable from '../components/admin/UsersTable.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import UiInput from '../components/ui/UiInput.vue'
import UiSelect from '../components/ui/UiSelect.vue'
import UiTabs from '../components/ui/UiTabs.vue'
import type { RosterUser } from '../lib/roster.js'
import { isAdmin, useMe, userId } from '../me.js'

type Access = 'loading' | 'denied' | 'ready'
const access = ref<Access>('loading')
const me = useMe()

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
// A row action's failure (approve/promote/unban), shown near the table without disturbing the roster
// already on screen.
const actionError = ref<string | null>(null)

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

// A monotonically increasing id for the in-flight `load()` call, so a response that comes back after a
// newer request has already started (a debounced keystroke can race a click, and a tab/pager click can
// race a slow response of its own) can be told apart from the one whose data should actually land. Only
// the call holding the current value when its response arrives may write anything — its errors included.
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
      // A newer load() has since started; this response is stale and must not touch state the newer
      // call already owns (or will own once it resolves).
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
    // The current page can empty out from under us — e.g. approving the sole row on the last page
    // drops `total` below `offset`. Snap back to the real last page and reload once rather than
    // stranding the view on an out-of-range page (that reload lands on a non-empty page, or on
    // total === 0, so it cannot recurse further).
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

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
function clearSearchDebounce(): void {
  if (searchDebounceTimer !== null) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
}

// Switching tabs or the search field always starts back at page 1 — the old offset would otherwise
// page into a differently-filtered result set. These are discrete clicks/selections, so they fire
// immediately; cancel any pending debounced search first so a mid-flight keystroke doesn't then re-send
// the same query a beat later.
watch([activeTab, searchField], () => {
  clearSearchDebounce()
  offset.value = 0
  void load()
})

// The search box fires on every keystroke; debounce it so typing doesn't send one request per
// character. A still-in-flight request from a superseded keystroke is handled by load()'s token guard.
watch(searchValue, () => {
  clearSearchDebounce()
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null
    offset.value = 0
    void load()
  }, SEARCH_DEBOUNCE_MS)
})

onUnmounted(clearSearchDebounce)

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

// ---- Direct row actions: approve / promote / demote / unban call straight through, then refetch the
// current page. The table disables every row's action while one is in flight, so a second click can't
// be silently dropped.

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

// ---- Dialog-backed actions: the page holds only which row a dialog targets and whether it is open;
// each dialog owns its form, request, and re-entrancy guard, and emits `done` so the page refetches.

const banTarget = ref<RosterUser | null>(null)
const banDialogOpen = ref(false)
const resetTarget = ref<RosterUser | null>(null)
const resetDialogOpen = ref(false)
const createDialogOpen = ref(false)

function openBanDialog(row: RosterUser): void {
  banTarget.value = row
  banDialogOpen.value = true
}

function openResetDialog(row: RosterUser): void {
  resetTarget.value = row
  resetDialogOpen.value = true
}

function openCreateDialog(): void {
  createDialogOpen.value = true
}

async function onCreated(): Promise<void> {
  offset.value = 0
  await load()
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
        <UiInput v-model="searchValue" type="text" placeholder="Search…" aria-label="Search users" />
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

        <UsersTable
          v-else
          :rows="rows"
          :total="total"
          :offset="offset"
          :page-size="PAGE_SIZE"
          :loading="loading"
          :role-busy-id="roleBusyId"
          :unban-busy-id="unbanBusyId"
          :self-id="userId(me.me)"
          @role-action="runRoleAction"
          @unban="runUnban"
          @ban="openBanDialog"
          @reset="openResetDialog"
          @prev="prevPage"
          @next="nextPage"
        />
      </template>
    </template>

    <BanUserDialog v-model:open="banDialogOpen" :target="banTarget" @done="load" />
    <ResetPasswordDialog v-model:open="resetDialogOpen" :target="resetTarget" @done="load" />
    <CreateUserDialog v-model:open="createDialogOpen" @done="onCreated" />
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
</style>
