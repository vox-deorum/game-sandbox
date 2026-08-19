<!--
  The season's peer ratings on the operator console, shown beside the Human Rating Prompt so the
  operator's guidance and the answers it produced sit together. One read feeds two summary tables:
  "By agent" answers what people thought of each agent (baselines included, mean descending), and
  "By rater" answers whether everyone did the peer review (every participant with a submission,
  including a zero count, ascending so the people who did nothing sort to the top). Each row opens
  the shared drill-in dialog, named with the rater on one side and the agent on the other.
-->
<script setup lang="ts">
import { agentRefKey } from '@game-sandbox/schema/board'
import { computed, onMounted, ref, watch } from 'vue'

import {
  type AdminSeasonAgentRatings,
  type AdminSeasonRatings,
  type AdminSeasonRaterRatings,
  type BoardAgentRef,
  listSeasonRatings,
} from '../../api/client.js'
import { formatDate, formatRating } from '../../lib/format.js'
import UiDialog from '../ui/UiDialog.vue'
import UiEmptyState from '../ui/UiEmptyState.vue'

const props = defineProps<{
  seasonId: string
}>()

const data = ref<AdminSeasonRatings | null>(null)
const loading = ref(true)
const selectedAgent = ref<AdminSeasonAgentRatings | null>(null)
const selectedRater = ref<AdminSeasonRaterRatings | null>(null)

/** The drill-in dialog is open exactly while one of the two tables has a selected row. The setter
 * lets the dialog's own dismissal (Esc, overlay, Close) clear the selection. */
const dialogOpen = computed({
  get: () => selectedAgent.value !== null || selectedRater.value !== null,
  set: (open: boolean) => {
    if (!open) {
      closeDialog()
    }
  },
})
const dialogTitle = computed(() => {
  if (selectedAgent.value !== null) {
    const count = selectedAgent.value.count
    return `${agentName(selectedAgent.value.agent)} · ${count} rating${count === 1 ? '' : 's'}`
  }
  if (selectedRater.value !== null) {
    const count = selectedRater.value.count
    return `${raterName(selectedRater.value)} · rated ${count} agent${count === 1 ? '' : 's'}`
  }
  return ''
})

/** The rater's display name, falling back to the stable id, matching the submissions list. */
function raterName(row: AdminSeasonRaterRatings): string {
  return row.rater_name ?? row.rater_user_id
}

/** One rated agent's name: the owner's display name for a submission, the declared label for a builtin. */
function agentName(agent: BoardAgentRef): string {
  return agent.kind === 'submission' ? (agent.user_name ?? agent.user_id) : (agent.label ?? agent.name)
}

/** The footnote under the by-rater table naming everyone who graded nobody, or an empty string. */
const zeroRaters = computed(() => {
  const names = (data.value?.by_rater ?? [])
    .filter((row) => row.count === 0)
    .map((row) => raterName(row))
  if (names.length === 0) {
    return ''
  }
  const joined = names.join(' and ')
  return `${joined} ${names.length === 1 ? 'has' : 'have'} not rated anyone.`
})

async function load(): Promise<void> {
  loading.value = true
  try {
    data.value = await listSeasonRatings(props.seasonId)
  } catch {
    // Tolerant failure: an unreadable ratings section renders its empty states rather than blocking.
    data.value = { by_agent: [], by_rater: [] }
  } finally {
    loading.value = false
  }
}

function closeDialog(): void {
  selectedAgent.value = null
  selectedRater.value = null
}

onMounted(load)
watch(
  () => props.seasonId,
  () => {
    closeDialog()
    void load()
  },
)
</script>

<template>
  <div class="ratings">
    <div class="ratings-head">
      <h2>Peer Ratings</h2>
    </div>

    <UiEmptyState v-if="loading">Loading…</UiEmptyState>
    <template v-else-if="data !== null">
      <div class="ratings-tables">
        <section class="ratings-table-wrap" aria-labelledby="by-agent-title">
          <h3 id="by-agent-title">By agent</h3>
          <UiEmptyState v-if="data.by_agent.length === 0">
            No ratings in this season yet.
          </UiEmptyState>
          <table v-else class="ratings-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col" class="num">Mean★</th>
                <th scope="col" class="num">Count</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in data.by_agent"
                :key="agentRefKey(row.agent)"
                class="ratings-row"
                @click="selectedAgent = row"
              >
                <td>
                  <button
                    type="button"
                    class="row-open-button"
                    @click.stop="selectedAgent = row"
                  >
                    {{ agentName(row.agent) }}
                  </button>
                </td>
                <td class="num">{{ formatRating(row.mean) }}</td>
                <td class="num">{{ row.count }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="ratings-table-wrap" aria-labelledby="by-rater-title">
          <h3 id="by-rater-title">By rater</h3>
          <UiEmptyState v-if="data.by_rater.length === 0">
            No participants in this season yet.
          </UiEmptyState>
          <template v-else>
            <table class="ratings-table">
              <thead>
                <tr>
                  <th scope="col">Rater</th>
                  <th scope="col" class="num">Graded</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in data.by_rater"
                  :key="row.rater_user_id"
                  class="ratings-row"
                  :class="{ zero: row.count === 0 }"
                  :title="row.count === 0 ? 'Has not rated anyone' : undefined"
                  @click="row.count > 0 && (selectedRater = row)"
                >
                  <td>{{ raterName(row) }}</td>
                  <td class="num">{{ row.count }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="zeroRaters !== ''" class="ratings-note">
              {{ zeroRaters }}
            </p>
          </template>
        </section>
      </div>
    </template>

    <UiDialog v-model:open="dialogOpen" :title="dialogTitle">
      <div v-if="selectedAgent !== null" class="ratings-list">
        <div v-for="(rating, index) in selectedAgent.ratings" :key="index" class="rating-row">
          <div class="rating-row-head">
            <span class="rating-score">★ {{ rating.score }}</span>
            <span class="rating-author">{{ rating.rater_name ?? rating.rater_user_id }}</span>
            <span class="rating-date">{{ formatDate(rating.rated_at) }}</span>
          </div>
          <p class="rating-text">{{ rating.feedback }}</p>
        </div>
      </div>
      <div v-else-if="selectedRater !== null" class="ratings-list">
        <div v-for="(rating, index) in selectedRater.ratings" :key="index" class="rating-row">
          <div class="rating-row-head">
            <span class="rating-score">★ {{ rating.score }}</span>
            <span class="rating-author">{{ agentName(rating.agent) }}</span>
            <span class="rating-date">{{ formatDate(rating.rated_at) }}</span>
          </div>
          <p class="rating-text">{{ rating.feedback }}</p>
        </div>
      </div>
    </UiDialog>
  </div>
</template>

<style scoped>
.ratings-head {
  margin-bottom: var(--space-4);
}

.ratings-head h2 {
  margin: 0;
  font-size: var(--text-lg);
}

.ratings-tables {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-5);
}

.ratings-table-wrap h3 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.ratings-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.ratings-table th,
.ratings-table td {
  text-align: left;
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.ratings-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.ratings-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.ratings-row {
  cursor: pointer;
}

.ratings-row:hover:not(.zero) {
  background: var(--color-surface-raised);
}

/* A rater who graded nobody sorts to the top but opens no dialog. */
.ratings-row.zero {
  color: var(--color-text-muted);
  cursor: default;
}

.row-open-button {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--color-accent);
  cursor: pointer;
  text-align: left;
}

.ratings-note {
  margin: var(--space-2) 0 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.ratings-list {
  display: flex;
  flex-direction: column;
}

.rating-row {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3) 0;
}

.rating-row + .rating-row {
  border-top: 1px solid var(--color-border);
}

.rating-row-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.rating-score {
  color: var(--color-warning);
  font-weight: 600;
}

.rating-author {
  font-weight: 600;
  font-size: var(--text-sm);
}

.rating-date {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.rating-text {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text);
  white-space: pre-wrap;
}

@media (max-width: 768px) {
  .ratings-tables {
    grid-template-columns: 1fr;
  }
}
</style>
