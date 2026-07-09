<!--
  The season's run history on the operator console: every run, newest first, as a compact table. Each
  row links to the run-details page (RunDetailsPage.vue) where the operator inspects that run's games
  and — while it is live — its streaming container logs. The console fetches the summaries (no frozen
  snapshots) and passes them in; this component is just the table and its empty state.
-->
<script setup lang="ts">
import { RouterLink } from 'vue-router'

import type { RunStatus, RunSummaryView } from '../../api/client.js'
import { formatDate } from '../../lib/format.js'
import UiEmptyState from '../ui/UiEmptyState.vue'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

defineProps<{
  runs: RunSummaryView[]
  envId: string
  seasonId: string
}>()

const STATUS_TONE: Record<RunStatus, 'neutral' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral',
  running: 'warning',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

function runHref(envId: string, seasonId: string, runId: string): string {
  return `/environments/${envId}/admin/seasons/${seasonId}/runs/${runId}`
}
</script>

<template>
  <UiEmptyState v-if="runs.length === 0">No runs yet.</UiEmptyState>
  <table v-else class="runs-table">
    <thead>
      <tr>
        <th scope="col">Started</th>
        <th scope="col">Status</th>
        <th scope="col">Games</th>
        <th scope="col">Requested by</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="run in runs" :key="run.id" data-testid="run-row">
        <td>
          <RouterLink class="run-link" :to="runHref(envId, seasonId, run.id)">
            {{ formatDate(run.started_at) ?? run.started_at }}
          </RouterLink>
        </td>
        <td><UiStatusBadge :tone="STATUS_TONE[run.status]" :label="run.status" /></td>
        <td>{{ run.game_count }}</td>
        <td :title="run.requested_by">{{ run.requested_by_name ?? run.requested_by }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.runs-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.runs-table th,
.runs-table td {
  text-align: left;
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.runs-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.run-link {
  color: var(--color-accent);
  text-decoration: none;
}

.run-link:hover {
  text-decoration: underline;
}
</style>
