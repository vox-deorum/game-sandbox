<!--
  Home: every environment as a card driven by the public metadata from `GET /api/environments`.

  Each card shows the display name, the short description, the slot count from min/max, a
  human-playable badge from `human_slots`, and the registry thumbnail, exactly the card fields the
  frontend spec names. The thumbnail comes from the registered renderer module, with a placeholder for
  an environment whose renderer is not registered yet.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { getEnvironments } from '../api/client.js'
import { thumbnailFor } from '../renderers/registry.js'

const environments = ref<EnvironmentMeta[] | null>(null)
const error = ref(false)

onMounted(() => {
  getEnvironments().then(
    (envs) => {
      environments.value = envs
    },
    () => {
      error.value = true
    },
  )
})

function slotLabel(meta: EnvironmentMeta): string {
  return meta.min_slots === meta.max_slots
    ? `${meta.min_slots} ${meta.min_slots === 1 ? 'slot' : 'slots'}`
    : `${meta.min_slots}–${meta.max_slots} slots`
}
</script>

<template>
  <p v-if="error" class="status">Could not load environments.</p>
  <p v-else-if="environments === null" class="status">Loading environments…</p>
  <section v-else>
    <h1>Environments</h1>
    <div class="card-grid">
      <RouterLink
        v-for="meta in environments"
        :key="meta.env_id"
        class="card"
        :to="`/environments/${meta.env_id}`"
      >
        <img class="card-thumb" :src="thumbnailFor(meta.renderer)" alt="" />
        <div class="card-body">
          <h2 class="card-title">{{ meta.display_name }}</h2>
          <p class="card-description">{{ meta.description }}</p>
          <div class="card-meta">
            <span class="badge">{{ slotLabel(meta) }}</span>
            <span v-if="meta.human_slots.length > 0" class="badge badge-human">Human playable</span>
          </div>
        </div>
      </RouterLink>
    </div>
  </section>
</template>
