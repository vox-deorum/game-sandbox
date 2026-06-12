<!--
  The recent-replays list on the environment page. The full replay viewer (load, play, scrub) lands in
  the replay-and-retention step; this lists the readable recordings for the environment, each linking
  to its `/replays/:id` page.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { listRecordings, type RecordingSummary } from '../api/client.js'
import { useMe } from '../me.js'

const props = defineProps<{ envId: string }>()
const me = useMe()

const replays = ref<RecordingSummary[] | null>(null)

onMounted(() => {
  // The backend filters to this environment, newest first; the page just renders the list.
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
  <p v-if="replays === null" class="status">Loading replays…</p>
  <p v-else-if="replays.length === 0" class="status">No replays yet.</p>
  <ul v-else class="replay-list">
    <li v-for="replay in replays" :key="replay.id">
      <RouterLink :to="`/replays/${replay.id}`">{{ replay.id }}</RouterLink>
      <span v-if="showsPin(replay)" class="pin-badge" title="Pinned">📌</span>
    </li>
  </ul>
</template>
