<!--
  The app shell: a two-tier navigation frame around the routed page. The collapsible left sidebar
  (AppSidebar) carries the global, cross-game sections; the contextual tab strip (ExperimentTabs)
  appears only inside a game and carries its per-game tasks. On narrow screens the sidebar becomes an
  off-canvas drawer behind a scrim, toggled from the mobile bar and closed again on navigation.

  It must render inside the me.ts provider (see App.vue): the account block and the tabs read the
  injected identity through useMe.
-->
<script setup lang="ts">
import { Menu } from '@lucide/vue'
import { computed, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import { useSidebar } from '../composables/useSidebar.js'
import { useSiteConfig } from '../composables/useSiteConfig.js'
import { useMe } from '../me.js'
import AppSidebar from './AppSidebar.vue'
import ExperimentTabs from './ExperimentTabs.vue'
import UiToast from './ui/UiToast.vue'

const route = useRoute()
const me = useMe()
const { collapsed, mobileOpen, toggleMobile, closeMobile } = useSidebar()
// The mobile bar is the tightest horizontal space, so it wears the compact short name.
const { siteIconUrl, siteShortName } = useSiteConfig()

/** The game tab strip shows only on routes scoped to one game (those carrying an :envId param). */
const inGame = computed(() => typeof route.params.envId === 'string' && route.params.envId !== '')

// A pending user may browse everything but cannot yet participate; a banner explains why the start,
// submit, and rate controls are disabled until an admin approves the account.
const pending = computed(() => me.me?.user?.status === 'pending')

// A drawer is momentary: close it whenever the route changes so a tapped link does not leave it open.
watch(() => route.fullPath, () => closeMobile())
</script>

<template>
  <div class="app" :class="{ 'sidebar-collapsed': collapsed, 'mobile-open': mobileOpen }">
    <header class="app-mobilebar">
      <button class="mobile-menu" type="button" aria-label="Open menu" @click="toggleMobile">
        <Menu :size="20" />
      </button>
      <RouterLink class="mobile-brand" to="/">
        <img class="mobile-brand-icon" :src="siteIconUrl" alt="" aria-hidden="true" />
        <span>{{ siteShortName }}</span>
      </RouterLink>
    </header>

    <AppSidebar />
    <button class="app-scrim" type="button" aria-label="Close menu" tabindex="-1" @click="closeMobile" />

    <div class="app-body">
      <div v-if="pending" class="pending-banner" role="status">
        <p class="pending-banner-title">Your account is awaiting approval.</p>
        <p class="pending-banner-text">
          You can browse freely. Starting sessions, submitting agents, and rating unlock once an admin
          approves your account.
        </p>
      </div>
      <ExperimentTabs v-if="inGame" />
      <main class="app-main">
        <RouterView />
      </main>
    </div>

    <UiToast />
  </div>
</template>

<style scoped>
.pending-banner {
  margin: var(--space-4) var(--space-5) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent);
  border-radius: var(--radius-sm);
  background: var(--color-surface-raised);
}

.pending-banner-title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-sm);
  font-weight: 600;
}

.pending-banner-text {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

@media (max-width: 768px) {
  .pending-banner {
    margin-left: var(--space-4);
    margin-right: var(--space-4);
  }
}
</style>
