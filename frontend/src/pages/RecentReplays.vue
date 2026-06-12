<!--
  The recent-replays list on the environment page. The full replay viewer (load, play, scrub) lands in
  the replay-and-retention step; this lists the readable recordings for the environment, each linking
  to its `/replays/:id` page.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { listRecordings, type RecordingSummary } from '../api/client.js'

const props = defineProps<{ envId: string }>()

const replays = ref<RecordingSummary[] | null>(null)

onMounted(() => {
  listRecordings({ env: props.envId }).then(
    (all) => {
      replays.value = all.filter((r) => r.header.environment === props.envId)
    },
    () => {
      replays.value = []
    },
  )
})
</script>

<template>
  <p v-if="replays === null" class="status">Loading replays…</p>
  <p v-else-if="replays.length === 0" class="status">No replays yet.</p>
  <ul v-else class="replay-list">
    <li v-for="replay in replays" :key="replay.id">
      <RouterLink :to="`/replays/${replay.id}`">{{ replay.id }}</RouterLink>
    </li>
  </ul>
</template>
