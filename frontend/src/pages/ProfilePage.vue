<!--
  My profile: the signed-in session user and what it may do, plus a jump to the cross-game agent index.
  It reads the shared /api/me state. When signed out it shows a sign-in prompt rather than a fabricated
  identity; the opaque user id is never the account label, only a diagnostic tooltip behind the name.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

import UiBadge from '../components/ui/UiBadge.vue'
import UiButton from '../components/ui/UiButton.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { isAdmin, useMe } from '../me.js'

const me = useMe()
const user = computed(() => me.me?.user ?? null)
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
      <dl class="profile-fields">
        <div class="field">
          <dt>Name</dt>
          <dd :title="user.id">{{ user.name }}</dd>
        </div>
        <div class="field">
          <dt>Email</dt>
          <dd>{{ user.email }}</dd>
        </div>
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
</style>
