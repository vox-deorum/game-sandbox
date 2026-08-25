<!--
  The two leaderboards stacked in one full-width column (Stage 6.7), per frontend.md. The same component renders the
  current released season embedded on the environment page, a specific season on the Leaderboards
  page, and the operator's verify-before-release view in the admin console — the data shape is identical,
  only the surrounding context differs.

  The boards never merge into one number, mirroring the spec. The automated board shows rank, agent,
  mean normalized score, the weighted mean agent compute time as its own column, a failure indicator,
  and a per-row Replay link into the Stage 4 viewer. The human-feedback board shows rank, agent, mean
  rating, count, and the same per-row Replay link (the agent's best automated game); an agent under
  three ratings appears unranked (the backend leaves its `rank` null).
-->
<script setup lang="ts">
import { maskedAgentLabel } from '@game-sandbox/schema/accounts'
import { agentRefKey } from '@game-sandbox/schema/board'
import { RouterLink } from 'vue-router'

import type { Board, BoardAgentRef } from '../api/client.js'
import { formatComputeSpread, formatRatingSpread, formatScoreSpread } from '../lib/format.js'
import { formatLlmCost } from '../lib/llm.js'
import { hidesNames, useMe } from '../me.js'
import LlmCostDetails from './LlmCostDetails.vue'
import UiBadge from './ui/UiBadge.vue'
import UiEmptyState from './ui/UiEmptyState.vue'

const props = defineProps<{ board: Board; envId: string; ratingPrompt?: string | null }>()

const me = useMe()

/** The owner id a submitted-agent row links to; null for an ownerless built-in row. */
function ownerOf(agent: BoardAgentRef): string | null {
  return agent.kind === 'submission' ? agent.user_id : null
}

/** The owner's display name for a submitted-agent row, falling back to the stable id, or the stable
 *  hash label for a masked (guest or anonymous) viewer, who never sees real names. */
function ownerNameOf(agent: BoardAgentRef): string | null {
  if (agent.kind !== 'submission') {
    return null
  }
  if (hidesNames(me.me)) {
    return maskedAgentLabel(agent.user_id)
  }
  return agent.user_name ?? agent.user_id
}

/** A built-in row's declared display label, falling back to its stable name when none resolved. */
function builtinLabelOf(agent: BoardAgentRef): string {
  return agent.kind === 'builtin' ? (agent.label ?? agent.name) : ''
}
</script>

<template>
  <div class="boards">
    <section class="board" aria-labelledby="automated-board-title">
      <h3 id="automated-board-title" class="board-title">Scoreboard</h3>
      <UiEmptyState v-if="props.board.automated.length === 0">
        No automated results yet.
      </UiEmptyState>
      <div v-else class="board-scroll">
        <table class="board-table automated-table">
          <colgroup>
            <col class="col-rank" />
            <col class="col-agent" />
            <col />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" class="rank">#</th>
              <th scope="col">Agent</th>
              <th scope="col" class="num">Mean score</th>
              <th scope="col" class="num">Agent compute</th>
              <th scope="col">LLM usage</th>
              <th scope="col" class="num">Games</th>
              <th scope="col">Replay</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, index) in props.board.automated"
              :key="agentRefKey(row.agent)"
            >
              <td class="rank">{{ index + 1 }}</td>
              <td>
                <RouterLink
                  v-if="ownerOf(row.agent) !== null"
                  class="agent-link"
                  :to="`/environments/${props.envId}/agents/${ownerOf(row.agent)}`"
                  :title="hidesNames(me.me) ? undefined : (ownerOf(row.agent) ?? undefined)"
                >
                  {{ ownerNameOf(row.agent) }}
                </RouterLink>
                <span v-else class="agent-naive">
                  {{ builtinLabelOf(row.agent) }} <UiBadge>Built-in</UiBadge>
                </span>
                <UiBadge
                  v-if="row.failure_count > 0"
                  variant="accent"
                  class="failure-flag"
                >
                  {{ row.failure_count }} failed
                </UiBadge>
              </td>
              <td class="num">
                {{ formatScoreSpread(row.mean_score, row.score_std) }}
              </td>
              <td class="num">
                {{ formatComputeSpread(row.mean_agent_compute_ms, row.compute_std) }}
              </td>
              <td class="llm-usage">
                <template v-if="row.llm_weighted_cost === null">None</template>
                <template v-else>
                  <span
                    class="llm-total"
                    >{{ formatLlmCost(row.llm_weighted_cost) }}</span
                  >
                  <LlmCostDetails
                    :usage-by-model="row.llm_usage_by_model"
                    :total-budget-cost-units="row.llm_weighted_cost"
                    by-model-disclosure
                  />
                </template>
              </td>
              <td class="num">{{ row.games }}</td>
              <td>
                <RouterLink
                  v-if="row.recording_id !== null"
                  class="replay-link"
                  :to="`/replays/${row.recording_id}`"
                >
                  Replay
                </RouterLink>
                <span v-else class="muted">None</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="board" aria-labelledby="human-board-title">
      <h3 id="human-board-title">Human Ratings</h3>
      <p v-if="props.ratingPrompt" class="board-prompt">
        “{{ props.ratingPrompt }}”
      </p>
      <UiEmptyState v-if="props.board.human.length === 0"
        >No ratings yet.</UiEmptyState
      >
      <div v-else class="board-scroll">
        <table class="board-table human-table">
          <colgroup>
            <col class="col-rank" />
            <col class="col-agent" />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col" class="rank">#</th>
              <th scope="col">Agent</th>
              <th scope="col" class="num">Mean rating</th>
              <th scope="col" class="num"># Ratings</th>
              <th scope="col">Replay</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in props.board.human"
              :key="agentRefKey(row.agent)"
              :class="{ unranked: row.rank === null }"
            >
              <td class="rank">
                <span v-if="row.rank !== null">{{ row.rank }}</span>
                <span v-else class="muted" title="Fewer than three ratings"
                  >None</span
                >
              </td>
              <td>
                <RouterLink
                  v-if="ownerOf(row.agent) !== null"
                  class="agent-link"
                  :to="`/environments/${props.envId}/agents/${ownerOf(row.agent)}`"
                  :title="hidesNames(me.me) ? undefined : (ownerOf(row.agent) ?? undefined)"
                >
                  {{ ownerNameOf(row.agent) }}
                </RouterLink>
                <span v-else class="agent-naive">
                  {{ builtinLabelOf(row.agent) }} <UiBadge>Built-in</UiBadge>
                </span>
                <p
                  v-if="row.author_prompt"
                  class="row-prompt"
                  :title="row.author_prompt"
                >
                  “{{ row.author_prompt }}”
                </p>
              </td>
              <td class="num">{{ formatRatingSpread(row.mean, row.std) }}</td>
              <td class="num">{{ row.count }}</td>
              <td>
                <RouterLink
                  v-if="row.recording_id !== null"
                  class="replay-link"
                  :to="`/replays/${row.recording_id}`"
                >
                  Replay
                </RouterLink>
                <span v-else class="muted">None</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.boards {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
}

/* The season's rating prompt, shown under the human board heading so readers see what was asked. */
.board-prompt {
  margin: calc(-1 * var(--space-2)) 0 var(--space-3);
  font-size: var(--text-sm);
  font-style: italic;
  color: var(--color-text-muted);
}

/* An agent author's own rating prompt, shown under its name. Clamped to one line (full text on hover)
   so a long prompt never balloons the row height. */
.row-prompt {
  margin: var(--space-1) 0 0;
  max-width: 100%;
  overflow: hidden;
  font-size: var(--text-sm);
  font-style: italic;
  color: var(--color-text-muted);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.board-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.board-scroll {
  overflow-x: auto;
}

.automated-table {
  min-width: max-content;
}

.llm-usage {
  white-space: nowrap;
}

.llm-total {
  margin-right: var(--space-2);
}

.llm-usage :deep(.llm-cost-details) {
  display: inline-grid;
}

/* Pin the leading columns to the same widths in both tables so the rank and
   agent columns line up across both boards. */
.board-table .col-rank {
  width: 3rem;
}

.board-table .col-agent {
  width: 14rem;
}

.board-table th,
.board-table td {
  text-align: left;
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.board-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

.board-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.agent-link {
  color: var(--color-text);
  transition: color var(--motion-fast) var(--ease-out);
}

.agent-link:hover {
  color: var(--color-accent);
}

.agent-naive {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text);
}

.failure-flag {
  margin-left: var(--space-2);
}

.replay-link {
  color: var(--color-accent);
}

.muted {
  color: var(--color-text-muted);
}

/* Under-threshold human rows read as "next in line" below the ranked set. */
.unranked {
  opacity: 0.7;
}
</style>
