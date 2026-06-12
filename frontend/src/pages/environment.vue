<!--
  Environment page: the description, the entry points into play and watch (gated by the allowlist),
  and the recent-replays list.

  The play and watch entry points are hidden when `/api/me` says the user is not allowlisted, and the
  backend enforces the same gate, so the UI state is courtesy and the backend check is the enforcement.
  Starting a session here is the seam the live-session step builds the full host on: it resolves to a
  session id this page navigates to, and the already-active case offers rejoin by navigating to the
  user's existing session instead of dead-ending. The per-step timeout override and the in-session
  controls (pause, the active-timeout display) live on the session page.

  Leaderboards and the submission form join in Stages 5 and 6; the page renders without them rather
  than carrying placeholders.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { getEnvironments, startSession } from '../api/client.js'
import { useMe } from '../me.js'
import RecentReplays from './RecentReplays.vue'

const route = useRoute()
const router = useRouter()
const me = useMe()

const envId = String(route.params.envId)
const meta = ref<EnvironmentMeta | null>(null)
const notFound = ref(false)
const startError = ref<string | null>(null)

onMounted(() => {
  getEnvironments().then(
    (envs) => {
      const found = envs.find((e) => e.env_id === envId)
      if (found === undefined) {
        notFound.value = true
      } else {
        meta.value = found
      }
    },
    () => {
      notFound.value = true
    },
  )
})

async function start(mode: 'human' | 'scripted'): Promise<void> {
  if (meta.value === null) {
    return
  }
  startError.value = null
  const result = await startSession({ envId: meta.value.env_id, mode })
  if (result.ok) {
    await router.push(`/sessions/${result.session.id}`)
  } else if (result.reason === 'already_active') {
    // Rejoin rather than dead-end: the user already has a session running.
    await router.push(`/sessions/${result.activeSessionId}`)
  } else if (result.reason === 'not_allowlisted') {
    startError.value = 'You are not on the session allowlist.'
  } else {
    startError.value = result.message
  }
}
</script>

<template>
  <p v-if="notFound" class="status">No such environment.</p>
  <p v-else-if="meta === null" class="status">Loading…</p>
  <section v-else>
    <h1>{{ meta.display_name }}</h1>
    <p class="env-description">{{ meta.description }}</p>

    <div v-if="me.me?.allowlisted" class="entry-points">
      <button v-if="meta.human_slots.length > 0" type="button" @click="start('human')">Play</button>
      <button type="button" @click="start('scripted')">Watch</button>
    </div>
    <p v-else class="status">Live play is limited to allowlisted users.</p>
    <p v-if="startError !== null" class="error">{{ startError }}</p>

    <h2>Recent replays</h2>
    <RecentReplays :env-id="meta.env_id" />
  </section>
</template>
