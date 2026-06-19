<!--
  My profile: the signed-in identity and what it may do, plus a jump to the cross-game agent index.
  Identity is the mock auto-logon today (see identity.ts); when OAuth lands this page grows the real
  account controls (and the sidebar's log-out becomes live). It reads the shared /api/me state.
-->
<script setup lang="ts">
import { RouterLink } from 'vue-router'

import { currentUserId } from '../identity.js'
import { useMe } from '../me.js'
import UiBadge from '../components/ui/UiBadge.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'

const me = useMe()
</script>

<template>
  <section class="profile">
    <header class="profile-intro">
      <h1>My profile</h1>
      <p class="profile-lede">Who you are signed in as, and what you can do.</p>
    </header>

    <UiEmptyState v-if="me.loading">Loading…</UiEmptyState>
    <UiCard v-else>
      <dl class="profile-fields">
        <div class="field">
          <dt>Signed in as</dt>
          <dd>{{ me.me?.user_id ?? currentUserId }}</dd>
        </div>
        <div class="field">
          <dt>Access</dt>
          <dd class="badges">
            <UiBadge v-if="me.me?.allowlisted" variant="accent">Allowlisted</UiBadge>
            <UiBadge v-else>Not allowlisted</UiBadge>
            <UiBadge v-if="me.me?.is_operator" variant="accent">Operator</UiBadge>
          </dd>
        </div>
      </dl>
      <p class="profile-note">
        Accounts and sign-out arrive with GitHub sign-in. For now you are signed in automatically.
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
