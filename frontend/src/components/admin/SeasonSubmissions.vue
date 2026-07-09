<!--
  The season's active submissions on the operator console: one current attempt per participant, with a
  per-row source download and a "download all" archive of the whole season. Downloads are native
  `<a download>` links (the browser streams the file and names it) pointing at the operator-gated admin
  routes; the browser sends the Better Auth session cookie on the same-origin navigation, so the admin
  guard authenticates the download with no query-param identity channel. A submission that failed
  before its snapshot was written has none, so its download is shown disabled rather than as a dead link.
-->
<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

import {
  type AdminSubmissionRow,
  adminSeasonDownloadUrl,
  adminSubmissionDownloadUrl,
  listSeasonSubmissions,
} from '../../api/client.js'
import { formatDate } from '../../lib/format.js'
import { submissionStatusLabel, submissionStatusTone } from '../../lib/submission-status.js'
import UiEmptyState from '../ui/UiEmptyState.vue'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

const props = defineProps<{
  seasonId: string
}>()

const rows = ref<AdminSubmissionRow[]>([])
const loading = ref(true)

async function load(): Promise<void> {
  loading.value = true
  try {
    rows.value = await listSeasonSubmissions(props.seasonId)
  } finally {
    loading.value = false
  }
}

function sourceLabel(row: AdminSubmissionRow): string {
  if (row.source_kind === 'local') {
    return 'local'
  }
  const short = row.commit_sha === null ? row.ref ?? 'default' : row.commit_sha.slice(0, 8)
  return `${row.repo_url ?? 'git'} @ ${short}`
}

onMounted(load)
watch(
  () => props.seasonId,
  () => {
    void load()
  },
)
</script>

<template>
  <div class="submissions">
    <div class="submissions-head">
      <a
        class="download-all"
        :href="adminSeasonDownloadUrl(seasonId)"
        :download="`season-${seasonId.slice(0, 8)}.tar.gz`"
      >
        Download all (.tar.gz)
      </a>
    </div>

    <UiEmptyState v-if="loading">Loading…</UiEmptyState>
    <UiEmptyState v-else-if="rows.length === 0">No submissions in this season yet.</UiEmptyState>
    <table v-else class="submissions-table">
      <thead>
        <tr>
          <th scope="col">Participant</th>
          <th scope="col">Status</th>
          <th scope="col">Source</th>
          <th scope="col">Submitted</th>
          <th scope="col">Download</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" data-testid="submission-row">
          <td :title="row.user_id">{{ row.user_name ?? row.user_id }}</td>
          <td>
            <UiStatusBadge
              :tone="submissionStatusTone(row.status)"
              :label="submissionStatusLabel(row.status)"
            />
          </td>
          <td class="source" :title="sourceLabel(row)">{{ sourceLabel(row) }}</td>
          <td>{{ formatDate(row.created_at) ?? row.created_at }}</td>
          <td>
            <a
              v-if="row.has_snapshot"
              class="download-link"
              :href="adminSubmissionDownloadUrl(row.id)"
              :download="`${row.user_id}-${row.id.slice(0, 8)}.tar.gz`"
            >
              Download
            </a>
            <span v-else class="download-none" title="No source snapshot for this submission">
              —
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.submissions-head {
  display: flex;
  justify-content: flex-end;
  margin-bottom: var(--space-3);
}

.download-all {
  color: var(--color-accent);
  text-decoration: none;
  font-size: var(--text-sm);
  font-weight: 600;
}

.download-all:hover {
  text-decoration: underline;
}

.submissions-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.submissions-table th,
.submissions-table td {
  text-align: left;
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.submissions-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.source {
  max-width: 20rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.download-link {
  color: var(--color-accent);
  text-decoration: none;
}

.download-link:hover {
  text-decoration: underline;
}

.download-none {
  color: var(--color-text-muted);
}
</style>
