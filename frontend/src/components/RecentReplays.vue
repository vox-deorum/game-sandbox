<!--
  The recent-replays list on the environment hub: the readable recordings for the environment, each
  linking to its `/replays/:id` page. The backend filters to this environment, newest first; the
  component just renders the list. A viewer's own pinned recording carries a text "Pinned" badge, so
  the pin signal is never a bare glyph (the accessibility baseline).
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { listRecordings, type RecordingSummary } from '../api/client.js'
import { useMe } from '../me.js'
import UiBadge from './ui/UiBadge.vue'
import UiEmptyState from './ui/UiEmptyState.vue'

const props = defineProps<{ envId: string }>()
const me = useMe()

const replays = ref<RecordingSummary[] | null>(null)

onMounted(() => {
  listRecordings({ env: props.envId }).then(
    (all) => {
      replays.value = all
    },
    () => {
      replays.value = []
    },
  )
})

/** Show a pin badge only on the viewer's own pinned recordings. */
function showsPin(replay: RecordingSummary): boolean {
  return replay.pinned && me.me?.user_id !== undefined && replay.user_id === me.me.user_id
}
</script>

<template>
  <UiEmptyState v-if="replays === null">Loading replays…</UiEmptyState>
  <UiEmptyState v-else-if="replays.length === 0">No replays yet.</UiEmptyState>
  <ul v-else class="replay-list">
    <li v-for="replay in replays" :key="replay.id" class="replay-row">
      <RouterLink class="replay-id" :to="`/replays/${replay.id}`">{{ replay.id }}</RouterLink>
      <UiBadge v-if="showsPin(replay)" variant="accent">Pinned</UiBadge>
    </li>
  </ul>
</template>

<style scoped>
.replay-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.replay-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  border-bottom: 1px solid var(--color-border);
}

.replay-id {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text);
  transition: color var(--motion-fast) var(--ease-out);
}

.replay-id:hover {
  color: var(--color-accent);
}
</style>
