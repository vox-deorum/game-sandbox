<!--
  The account block pinned to the bottom of the sidebar: the signed-in identity, a link to the profile
  page, and a log-out affordance. Today identity is the mock auto-logon (see identity.ts), so log-out
  has nothing to end and stays an inert seam — it becomes real when OAuth lands, the same swap me.ts is
  built for. The label falls back to the locally resolved id while /api/me is in flight so it never
  flickers between empty and filled.
-->
<script setup lang="ts">
import { LogOut, User } from '@lucide/vue'
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { currentUserId } from '../identity.js'
import { useMe } from '../me.js'

const me = useMe()
const route = useRoute()

const userLabel = computed(() => (me.loading ? 'signing in…' : me.me?.user_id ?? currentUserId))
const profileActive = computed(() => route.path.startsWith('/my/profile'))
</script>

<template>
  <div class="account">
    <RouterLink
      class="account-link"
      :class="{ active: profileActive }"
      to="/my/profile"
      :title="userLabel"
    >
      <User class="account-icon" :size="20" />
      <span class="account-text">
        <span class="account-name">{{ userLabel }}</span>
        <span class="account-sub">My profile</span>
      </span>
    </RouterLink>
    <button class="logout" type="button" disabled title="Sign-out arrives with accounts">
      <LogOut class="account-icon" :size="18" />
      <span class="account-text">Log out</span>
    </button>
  </div>
</template>

<style scoped>
.account {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.account-link,
.logout {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  white-space: nowrap;
  text-align: left;
}

.account-link {
  transition: color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out);
}

.account-link:hover {
  color: var(--color-text);
  background: var(--color-surface-raised);
}

.account-link.active {
  color: var(--color-text);
  background: var(--color-surface-raised);
}

.account-icon {
  flex: none;
}

.account-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.account-name {
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}

.account-sub {
  font-size: var(--text-xs);
}

.logout {
  font: inherit;
  border: none;
  background: transparent;
  cursor: not-allowed;
  opacity: 0.6;
}

.logout .account-text {
  font-size: var(--text-sm);
}

/* The collapsed-rail rule that hides .account-text keys off the .app ancestor, so it lives in
   styles/app.css (a scoped block cannot select an ancestor without the miscompiling :global()). */
</style>
