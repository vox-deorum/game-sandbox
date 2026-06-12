<!--
  The replay viewer page. This infrastructure step provides the route and a placeholder; the
  replay-and-retention step replaces it with the viewer (load by URL, play, pause, step, scrub) over
  the same renderer the live host uses.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const id = computed(() => String(route.params.id))
</script>

<template>
  <section>
    <h1>Replay</h1>
    <p class="status">
      The replay viewer for recording <code>{{ id }}</code> lands in the replay step.
    </p>
  </section>
</template>
