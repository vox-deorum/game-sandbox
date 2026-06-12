<!--
  The live session page. This infrastructure step provides the route and a placeholder; the
  live-session-control step replaces it with the renderer host over the live socket, the human-slot
  timeout control, pause/resume, and the end-of-session card.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const id = computed(() => String(route.params.id))
</script>

<template>
  <section>
    <h1>Session</h1>
    <p class="status">
      The live play host for session <code>{{ id }}</code> lands in the live-session step.
    </p>
  </section>
</template>
