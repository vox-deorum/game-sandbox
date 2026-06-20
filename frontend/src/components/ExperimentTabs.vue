<!--
  The per-game contextual tab strip, shown by the shell only on /environments/:envId/* routes. It is
  the second navigation tier: the sidebar carries the cross-game jobs, these tabs carry the in-game
  tasks. Tabs are labelled by task, not by data model — and the Submit/My Agent tab is one tab that
  reads "Submit" until the signed-in user has an agent here, then "My Agent" (its page hosts the
  resubmission form). The season switcher makes "the current season" the default you are already in,
  with past seasons reachable by selecting them; changing it opens that season's leaderboard.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { getAgentProfile, getEnvironments, type SeasonView, listReleasedSeasons } from '../api/client.js'
import { currentUserId } from '../identity.js'
import { useMe } from '../me.js'

const route = useRoute()
const router = useRouter()
const me = useMe()

const envId = computed(() => String(route.params.envId))
const gameName = ref('')
const history = ref<SeasonView[]>([])
const hasSubmitted = ref(false)

/** The current user's id, used both for the My Agent tab target and the has-submitted lookup. */
const ownerId = computed(() => me.me?.user_id ?? currentUserId)

async function load(id: string): Promise<void> {
  getEnvironments().then(
    (envs) => {
      gameName.value = envs.find((e) => e.env_id === id)?.display_name ?? id
    },
    () => {
      gameName.value = id
    },
  )
  listReleasedSeasons(id).then(
    (rows) => {
      history.value = rows
    },
    () => {
      history.value = []
    },
  )
  await me.whenSettled()
  getAgentProfile(id, ownerId.value).then(
    (profile) => {
      hasSubmitted.value = profile.submissions.length > 0
    },
    () => {
      hasSubmitted.value = false
    },
  )
}

watch(envId, (id) => void load(id), { immediate: true })

const tabs = computed(() => {
  const base = `/environments/${envId.value}`
  const list = [
    { key: 'overview', label: 'Overview', to: base, active: route.path === base },
    {
      key: 'leaderboard',
      label: 'Leaderboard',
      to: `${base}/leaderboards`,
      active: route.path.startsWith(`${base}/leaderboards`),
    },
    {
      key: 'agent',
      label: hasSubmitted.value ? 'My Agent' : 'Submit',
      to: `${base}/agents/${ownerId.value}`,
      active: route.path.startsWith(`${base}/agents`),
    },
  ]
  if (me.me?.is_operator) {
    list.push({
      key: 'manage',
      label: 'Manage',
      to: `${base}/admin`,
      active: route.path.startsWith(`${base}/admin`),
    })
  }
  return list
})

/** "Season 3" from the operator label, or a short id when a season was never named. */
function seasonLabel(view: SeasonView): string {
  return view.label ?? `Season ${view.id.slice(0, 8)}`
}

/** The season id in the URL (on the leaderboard tab), or '' for the current-season default. */
const selectedSeason = computed(() => {
  const raw = route.params.seasonId
  return typeof raw === 'string' ? raw : ''
})

function onSeasonChange(event: Event): void {
  const id = (event.target as HTMLSelectElement).value
  const base = `/environments/${envId.value}/leaderboards`
  void router.push(id === '' ? base : `${base}/${id}`)
}
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
      <label v-if="history.length > 0" class="season-switch">
        <span class="season-switch-label">Season</span>
        <select :value="selectedSeason" @change="onSeasonChange">
          <option value="">Current</option>
          <option v-for="entry in history" :key="entry.id" :value="entry.id">
            {{ seasonLabel(entry) }}
          </option>
        </select>
      </label>
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
  padding: var(--space-3) var(--space-5) 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
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
  gap: var(--space-4);
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
}

.tab {
  padding: var(--space-2) var(--space-2) var(--space-3) var(--space-2);
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

.season-switch {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  padding-bottom: var(--space-2);
}

.season-switch select {
  font: inherit;
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
}

@media (max-width: 768px) {
  .tabs-inner {
    padding-left: var(--space-4);
    padding-right: var(--space-4);
  }
}
</style>
