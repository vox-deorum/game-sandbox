<!--
  The root component: it wraps the app shell in the `me.ts` provider so the one `GET /api/me` fetch
  backs both the header and every page. The shell itself (header chrome plus the routed page) lives in
  AppShell.vue, which must be a descendant of the provider to read the injected identity.
-->
<script setup lang="ts">
import AppShell from './components/AppShell.vue'
import { MeProvider } from './me.js'
</script>

<template>
  <MeProvider>
    <AppShell />
  </MeProvider>
</template>
