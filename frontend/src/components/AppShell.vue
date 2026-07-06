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
import AppSidebar from './AppSidebar.vue'
import ExperimentTabs from './ExperimentTabs.vue'

const route = useRoute()
const { collapsed, mobileOpen, toggleMobile, closeMobile } = useSidebar()
// The mobile bar is the tightest horizontal space, so it wears the compact short name.
const { siteShortName } = useSiteConfig()

/** The game tab strip shows only on routes scoped to one game (those carrying an :envId param). */
const inGame = computed(() => typeof route.params.envId === 'string' && route.params.envId !== '')

// A drawer is momentary: close it whenever the route changes so a tapped link does not leave it open.
watch(() => route.fullPath, () => closeMobile())
</script>

<template>
  <div class="app" :class="{ 'sidebar-collapsed': collapsed, 'mobile-open': mobileOpen }">
    <header class="app-mobilebar">
      <button class="mobile-menu" type="button" aria-label="Open menu" @click="toggleMobile">
        <Menu :size="20" />
      </button>
      <RouterLink class="mobile-brand" to="/">{{ siteShortName }}</RouterLink>
    </header>

    <AppSidebar />
    <button class="app-scrim" type="button" aria-label="Close menu" tabindex="-1" @click="closeMobile" />

    <div class="app-body">
      <ExperimentTabs v-if="inGame" />
      <main class="app-main">
        <RouterView />
      </main>
    </div>
  </div>
</template>
