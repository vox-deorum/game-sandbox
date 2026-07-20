<!--
  The per-game contextual tab strip, shown by the shell only on /environments/:envId/* routes. It is
  the second navigation tier: the sidebar carries the cross-game jobs, these tabs carry the in-game
  tasks. Tabs are labelled by task, not by data model — the "My Submissions" tab hosts the agent
  profile and resubmission form.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { environmentMeta } from '../environmentCatalog.js'
import { isAdmin, useMe, userId } from '../me.js'

// The env id normally comes from the route (the shell mounts these tabs on /environments/:envId/*),
// but the session page (route /sessions/:id) passes it explicitly so the same strip can render there.
const props = defineProps<{ envId?: string }>()

const route = useRoute()
const me = useMe()

const envId = computed(() => props.envId ?? String(route.params.envId))
const gameName = ref('')

/** The signed-in user's id, used as the My Submissions tab target; null for an anonymous visitor. */
const ownerId = computed(() => userId(me.me))

function load(id: string): void {
  environmentMeta(id).then(
    (meta) => {
      gameName.value = meta?.display_name ?? id
    },
    () => {
      gameName.value = id
    },
  )
}

watch(envId, (id) => load(id), { immediate: true })

const tabs = computed(() => {
  const base = `/environments/${envId.value}`
  const list = [
    { key: 'overview', label: 'Overview', to: base, active: route.path === base },
    {
      key: 'leaderboard',
      label: 'Leaderboards',
      to: `${base}/leaderboards`,
      active: route.path.startsWith(`${base}/leaderboards`),
    },
    {
      key: 'replays',
      label: 'Replays',
      to: `${base}/replays`,
      active: route.path.startsWith(`${base}/replays`),
    },
  ]
  // An anonymous visitor has no submissions of their own, so the tab is omitted until they sign in.
  if (ownerId.value !== null) {
    list.push({
      key: 'agent',
      label: 'My Submissions',
      to: `${base}/agents/${ownerId.value}`,
      active: route.path.startsWith(`${base}/agents`),
    })
  }
  if (isAdmin(me.me)) {
    list.push({
      key: 'manage',
      label: 'Manage',
      to: `${base}/admin`,
      active: route.path.startsWith(`${base}/admin`),
    })
  }
  return list
})
</script>

<template>
  <div class="experiment-tabs">
    <div class="tabs-inner">
      <RouterLink class="game-name" :to="`/environments/${envId}`">{{ gameName || envId }}</RouterLink>
      <nav class="tab-row" aria-label="Environment sections">
        <RouterLink
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: tab.active }"
          :to="tab.to"
        >
          {{ tab.label }}
        </RouterLink>
      </nav>
    </div>
  </div>
</template>

<style scoped>
.experiment-tabs {
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.tabs-inner {
  max-width: 960px;
  margin: 0 auto;
  padding: var(--space-3) 0 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.game-name {
  font-family: var(--font-heading);
  font-size: var(--text-lg);
  font-weight: 700;
  white-space: nowrap;
  /* Match the tabs' vertical padding so the title text aligns with the tab labels. */
  padding: var(--space-2) 0 var(--space-3);
}

.game-name:hover {
  color: var(--color-accent);
}

.tab-row {
  display: flex;
  align-items: stretch;
  margin-left: var(--space-4);
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
}

.tab {
  padding: var(--space-2) var(--space-4) var(--space-3) var(--space-4);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}

.tab:hover {
  color: var(--color-text);
}

.tab.active {
  color: var(--color-text);
  font-weight: 600;
  border-bottom-color: var(--color-accent);
}
</style>
