<!--
  My profile: the signed-in session user and what it may do, plus a jump to the cross-game agent index.
  It reads the shared /api/me state. When signed out it shows a sign-in prompt rather than a fabricated
  identity; the opaque user id is never the account label, only a diagnostic tooltip behind the name.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { authClient } from '../auth.js'
import UiAvatar from '../components/ui/UiAvatar.vue'
import UiBadge from '../components/ui/UiBadge.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { useSiteConfig } from '../composables/useSiteConfig.js'
import { isAdmin, useMe } from '../me.js'

const me = useMe()
const route = useRoute()
const { githubAuth } = useSiteConfig()
const user = computed(() => me.me?.user ?? null)
const signedInUserId = computed(() => user.value?.id ?? null)

interface LinkedAccount {
  providerId: string
  accountId: string
}

const accounts = ref<LinkedAccount[]>([])
const accountsLoading = ref(false)
const accountActionBusy = ref(false)
const callbackError = (() => {
  const code = route.query.error
  if (typeof code !== 'string') {
    return null
  }
  const detail = route.query.error_description
  const message = typeof detail === 'string' ? detail : code.replaceAll('_', ' ')
  return `Could not connect GitHub: ${message}.`
})()
const accountError = ref<string | null>(null)
const githubAccount = computed(() => accounts.value.find((account) => account.providerId === 'github') ?? null)
const githubUsername = computed(() => user.value?.github_username ?? null)
const canDisconnectGithub = computed(() => githubAccount.value !== null && accounts.value.length > 1)

function githubProfileUrl(username: string): string {
  return `https://github.com/${encodeURIComponent(username)}`
}

async function refreshAccounts(): Promise<void> {
  accountsLoading.value = true
  accountError.value = null
  try {
    const { data, error } = await authClient.listAccounts()
    if (error !== null) {
      accountError.value = error.message ?? 'Could not load connected accounts.'
      return
    }
    accounts.value = (data ?? []) as LinkedAccount[]
  } catch {
    accountError.value = 'Could not load connected accounts.'
  } finally {
    accountsLoading.value = false
  }
}

async function connectGithub(): Promise<void> {
  accountActionBusy.value = true
  accountError.value = null
  try {
    const { error } = await authClient.linkSocial({
      provider: 'github',
      callbackURL: '/my/profile',
      errorCallbackURL: '/my/profile',
    })
    if (error !== null) {
      accountError.value = error.message ?? 'Could not start GitHub connection.'
      return
    }
    await Promise.all([refreshAccounts(), me.refresh()])
  } catch {
    accountError.value = 'Could not start GitHub connection.'
  } finally {
    accountActionBusy.value = false
  }
}

async function disconnectGithub(): Promise<void> {
  const account = githubAccount.value
  if (account === null || !canDisconnectGithub.value) {
    return
  }
  accountActionBusy.value = true
  accountError.value = null
  try {
    const { error } = await authClient.unlinkAccount({
      providerId: 'github',
      accountId: account.accountId,
    })
    if (error !== null) {
      accountError.value = error.message ?? 'Could not disconnect GitHub.'
      return
    }
    await Promise.all([refreshAccounts(), me.refresh()])
  } catch {
    accountError.value = 'Could not disconnect GitHub.'
  } finally {
    accountActionBusy.value = false
  }
}

watch(
  [githubAuth, signedInUserId],
  ([enabled, currentUserId]) => {
    if (enabled && currentUserId !== null) {
      void refreshAccounts()
    }
    if (!enabled) {
      accounts.value = []
      accountError.value = null
    }
    if (currentUserId === null) {
      accounts.value = []
      accountError.value = null
    }
  },
  { immediate: true },
)
</script>

<template>
  <section class="profile">
    <header class="profile-intro">
      <h1>My profile</h1>
      <p class="profile-lede">Who you are signed in as, and what you can do.</p>
    </header>

    <UiEmptyState v-if="me.loading">Loading…</UiEmptyState>
    <UiCard v-else-if="user === null" class="profile-signedout">
      <p class="profile-note">You are not signed in.</p>
      <UiButton to="/login">Sign in</UiButton>
    </UiCard>
    <UiCard v-else>
      <div class="profile-identity">
        <UiAvatar :name="user.name" :image="user.image" size="profile" />
        <div>
          <h2 :title="user.id">{{ user.name }}</h2>
          <p>{{ user.email }}</p>
        </div>
      </div>
      <dl class="profile-fields">
        <div class="field">
          <dt>Access</dt>
          <dd class="badges">
            <UiBadge v-if="isAdmin(me.me)" variant="accent">Operator</UiBadge>
            <UiBadge v-else-if="user.status === 'normal'" variant="accent">Member</UiBadge>
            <UiBadge v-else>Awaiting approval</UiBadge>
          </dd>
        </div>
      </dl>
      <p v-if="user.status === 'pending'" class="profile-note">
        Your account is awaiting approval. You can browse; starting sessions, submitting, and rating
        unlock once an admin approves you.
      </p>
      <RouterLink class="profile-link" to="/my/agents">View my agents →</RouterLink>
    </UiCard>

    <section v-if="githubAuth && user !== null" class="connected-accounts">
      <h2>Connected accounts</h2>
      <UiCard class="connected-card">
        <UiEmptyState v-if="accountsLoading">Loading connected accounts…</UiEmptyState>
        <UiEmptyState v-if="callbackError !== null" tone="danger" role="alert">
          {{ callbackError }}
        </UiEmptyState>
        <UiEmptyState v-if="accountError !== null" tone="danger" role="alert">
          {{ accountError }}
        </UiEmptyState>
        <template v-if="!accountsLoading && githubAccount !== null">
          <p v-if="githubUsername !== null" class="connected-copy">
            <a
              :href="githubProfileUrl(githubUsername)"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub @{{ githubUsername }}
            </a>
            is connected to this account.
          </p>
          <p v-else class="connected-copy">A GitHub account is connected to this account.</p>
          <UiButton
            variant="danger"
            size="tight"
            :disabled="!canDisconnectGithub"
            :loading="accountActionBusy"
            @click="disconnectGithub"
          >
            Disconnect GitHub
          </UiButton>
          <p v-if="!canDisconnectGithub" class="connected-note">
            GitHub is your only sign-in method, so it cannot be disconnected.
          </p>
        </template>
        <template v-else-if="!accountsLoading">
          <p class="connected-copy">Connect GitHub to show your handle on your profile and agent pages.</p>
          <UiButton :loading="accountActionBusy" @click="connectGithub">Connect GitHub</UiButton>
        </template>
      </UiCard>
    </section>
  </section>
</template>

<style scoped>
.profile-intro {
  margin-bottom: var(--space-5);
}

.profile-intro h1 {
  margin: 0 0 var(--space-1);
}

.profile-lede {
  margin: 0;
  color: var(--color-text-muted);
}

.profile-signedout {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
}

.profile-identity {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}

.profile-identity h2,
.profile-identity p {
  margin: 0;
}

.profile-identity p,
.connected-note {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.profile-fields {
  margin: 0 0 var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.field {
  display: flex;
  gap: var(--space-3);
  align-items: baseline;
}

.field dt {
  width: 8rem;
  flex: none;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.field dd {
  margin: 0;
}

.badges {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.profile-note {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.profile-link {
  color: var(--color-accent);
  font-size: var(--text-sm);
}

.connected-accounts {
  margin-top: var(--space-6);
}

.connected-accounts h2 {
  margin: 0 0 var(--space-3);
}

.connected-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
}

.connected-copy,
.connected-note {
  margin: 0;
}

.connected-copy a {
  color: var(--color-accent);
}
</style>
