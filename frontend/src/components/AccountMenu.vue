<!--
  The account block pinned to the bottom of the sidebar. Signed in, it shows the session user's name,
  a link to the profile page, and a working "Log out". Signed out, it shows a "Sign in" link to /login
  in place of the account block. Log-out ends the Better Auth session through authClient, then does a
  full-page navigation to /login so the one /api/me fetch re-runs and the shell renders signed-out.
-->
<script setup lang="ts">
import { LogIn, LogOut, User } from '@lucide/vue'
import { computed, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { authClient } from '../auth.js'
import { useMe } from '../me.js'

const me = useMe()
const route = useRoute()

// The session user, or null when anonymous. While the single /api/me fetch is in flight we keep the
// signed-in layout with a placeholder label so the block never flickers between states.
const user = computed(() => me.me?.user ?? null)
const userLabel = computed(() => (me.loading ? 'signing in…' : user.value?.name ?? ''))
const profileActive = computed(() => route.path.startsWith('/my/profile'))
const signingOut = ref(false)

async function logOut(): Promise<void> {
  if (signingOut.value) {
    return
  }
  signingOut.value = true
  try {
    await authClient.signOut()
  } finally {
    // A full navigation re-runs /api/me so the shell renders its signed-out state from one source.
    window.location.assign('/login')
  }
}
</script>

<template>
  <div class="account">
    <template v-if="user !== null || me.loading">
      <RouterLink
        class="account-link"
        :class="{ active: profileActive }"
        to="/my/profile"
        :title="user?.email ?? userLabel"
      >
        <User class="account-icon" :size="20" />
        <span class="account-text">
          <span class="account-name">{{ userLabel }}</span>
          <span class="account-sub">My profile</span>
        </span>
      </RouterLink>
      <button class="logout" type="button" :disabled="signingOut" @click="logOut">
        <LogOut class="account-icon" :size="18" />
        <span class="account-text">Log out</span>
      </button>
    </template>
    <RouterLink v-else class="account-link" to="/login">
      <LogIn class="account-icon" :size="20" />
      <span class="account-text">
        <span class="account-name">Sign in</span>
        <span class="account-sub">Not signed in</span>
      </span>
    </RouterLink>
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
  transition: color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out);
}

.account-link:hover,
.logout:hover:not(:disabled) {
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
  cursor: pointer;
}

.logout:disabled {
  cursor: default;
  opacity: 0.6;
}

.logout .account-text {
  font-size: var(--text-sm);
}

/* The collapsed-rail rule that hides .account-text keys off the .app ancestor, so it lives in
   styles/app.css (a scoped block cannot select an ancestor without the miscompiling :global()). */
</style>
