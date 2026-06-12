<!--
  The app shell: the header chrome (site name and the signed-in user) around the routed page. It reads
  the injected identity through useMe, so it must render inside the me.ts provider (see App.vue). While
  /api/me is in flight it falls back to the locally resolved id so the header never flickers.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, RouterView } from 'vue-router'

import { currentUserId } from '../identity.js'
import { useMe } from '../me.js'

const me = useMe()
const signedInLabel = computed(() =>
  me.loading ? 'signing in…' : `signed in as ${me.me?.user_id ?? currentUserId}`,
)
</script>

<template>
  <div class="app">
    <header class="app-header">
      <RouterLink class="site-name" to="/">Game Sandbox</RouterLink>
      <span class="signed-in">{{ signedInLabel }}</span>
    </header>
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>
