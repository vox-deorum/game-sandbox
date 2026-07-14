<!--
  Home: the environment gallery, the reference page for the Stage 4.5 design system. Every environment
  is one card driven by the public metadata from `GET /api/environments`.

  Each card shows the display name, the short description, the slot count from min/max, a
  human-playable badge from `human_slots`, and the registry thumbnail, exactly the card fields the
  frontend spec names. The thumbnail comes from the registered renderer module, with a placeholder for
  an environment whose renderer is not registered yet. The whole card is one link to the environment
  hub; nothing else on the page competes with the cards.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import UiBadge from '../components/ui/UiBadge.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { loadEnvironmentCatalog } from '../environmentCatalog.js'
import { slotLabel } from '../lib/format.js'
import { thumbnailFor } from '../renderers/registry.js'

const environments = ref<EnvironmentMeta[] | null>(null)
const error = ref(false)

onMounted(() => {
  loadEnvironmentCatalog().then(
    (envs) => {
      environments.value = envs
    },
    () => {
      error.value = true
    },
  )
})
</script>

<template>
  <UiEmptyState v-if="error" tone="danger">Could not load environments.</UiEmptyState>
  <UiEmptyState v-else-if="environments === null">Loading environments…</UiEmptyState>
  <section v-else class="home">
    <header class="home-intro">
      <h1>Environments</h1>
      <p class="home-lede">Watch agents play, or play yourself.</p>
    </header>
    <div class="card-grid">
      <RouterLink
        v-for="meta in environments"
        :key="meta.env_id"
        class="env-card-link"
        :to="`/environments/${meta.env_id}`"
      >
        <UiCard :padded="false" interactive>
          <img class="env-thumb" :src="thumbnailFor(meta.renderer)" alt="" />
          <div class="env-body">
            <h2 class="env-title">{{ meta.display_name }}</h2>
            <p class="env-description">{{ meta.description }}</p>
            <div class="env-meta">
              <UiBadge>{{ slotLabel(meta) }}</UiBadge>
              <UiBadge v-if="meta.human_slots.length > 0" variant="accent">Human playable</UiBadge>
            </div>
          </div>
        </UiCard>
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.home-intro {
  margin-bottom: var(--space-5);
}

.home-intro h1 {
  margin: 0 0 var(--space-1);
}

.home-lede {
  margin: 0;
  color: var(--color-text-muted);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--space-4);
}

/* The whole card is the link; the card primitive carries the surface and hover affordance. */
.env-card-link {
  display: block;
}

.env-thumb {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  background: var(--color-surface-raised);
}

.env-body {
  padding: var(--space-3) var(--space-4) var(--space-4);
}

.env-title {
  margin: 0 0 var(--space-1);
  font-size: var(--text-lg);
}

.env-description {
  margin: 0 0 var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.env-meta {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}
</style>
