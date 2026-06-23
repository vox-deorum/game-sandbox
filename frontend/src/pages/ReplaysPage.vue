<!--
  The environment's Replays tab: the readable recordings for this environment as a sortable table.
  The backend listing is open to everyone (read-only) and filtered to this environment, newest first;
  this page resolves each replay's season label and play state from the environment's season list and
  lets the viewer re-sort client-side. Submitted-agent attribution is masked for non-operators while
  that season remains playable. A row links to its `/replays/:id` viewer; the viewer's own pinned
  recording carries a text "Pinned" badge, so the pin signal is never a bare glyph.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import {
  listRecordings,
  listSeasons,
  type PublicSeasonView,
  type RecordingSummary,
  watchAgentNumbers,
} from '../api/client.js'
import UiBadge from '../components/ui/UiBadge.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { formatDateOnly, formatSlotIndex } from '../lib/format.js'
import { useMe } from '../me.js'
import { reasonText } from '../replay/reason.js'

const route = useRoute()
const me = useMe()
const envId = computed(() => String(route.params.envId))

const replays = ref<RecordingSummary[] | null>(null)
/** season id → public season facts, used for labels and playable-season anonymity. */
const seasonsById = ref<Map<string, PublicSeasonView>>(new Map())
// Submission id → season-wide anonymous number for the env's play-open season (the only one a blind
// replay can belong to), so a masked row reads the same "Submitted agent N" as the rating panel.
const anonymousNumbers = ref<Record<string, number>>({})

/** The sortable columns and the current sort. Default newest-first, matching the backend order. */
type SortKey = 'id' | 'owner' | 'season' | 'outcome' | 'created'
const sort = ref<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'created', dir: 'desc' })

function seasonLabel(season: PublicSeasonView): string {
  return season.label ?? `Season ${season.id.slice(0, 8)}`
}

/** A compact one-line summary of who played, read from the recording header's `players` map. */
function playersSummary(replay: RecordingSummary): string {
  const { header } = replay
  const players = header.players
  if (players === undefined) {
    return '—'
  }
  const blind = isBlindReplay(replay)
  const parts = Object.entries(players).map(([slot, player]) =>
    player.kind === 'human'
      ? `${formatSlotIndex(slot)}: Human (${player.user ?? player.label})`
      : `${formatSlotIndex(slot)}: ${
          blind && player.submission_id !== undefined
            ? player.user === me.me?.user_id
              ? 'Your agent'
              : blindAgentLabel(player.submission_id)
            : player.label
        }`,
  )
  return parts.length > 0 ? parts.join(', ') : '—'
}

/** A blind submitted agent's label, numbered to match the watch picker and rating panel. */
function blindAgentLabel(submissionId: string): string {
  const number = anonymousNumbers.value[submissionId]
  return number === undefined ? 'Submitted agent' : `Submitted agent ${number}`
}

/** The replay id with its leading `⟨environment⟩-` prefix dropped, since the page is already scoped
 *  to one environment — the prefix is redundant noise that only crowds the column. */
function displayId(replay: RecordingSummary): string {
  const prefix = `${envId.value}-`
  return replay.id.startsWith(prefix) ? replay.id.slice(prefix.length) : replay.id
}

function seasonText(replay: RecordingSummary): string {
  if (replay.season_id === null) {
    return '—'
  }
  const season = seasonsById.value.get(replay.season_id)
  return season === undefined ? '—' : seasonLabel(season)
}

function hasSubmittedAgent(replay: RecordingSummary): boolean {
  return Object.values(replay.header.players ?? {}).some(
    (player) => player.kind === 'agent' && player.submission_id !== undefined,
  )
}

function isBlindReplay(replay: RecordingSummary): boolean {
  // Fail closed: only a confirmed operator is exempt; an unresolved identity stays blind.
  if (me.me?.is_operator === true || replay.season_id === null || !hasSubmittedAgent(replay)) {
    return false
  }
  return seasonsById.value.get(replay.season_id)?.play_status === 'open'
}

/** Show a pin badge only on the viewer's own pinned recordings. */
function showsPin(replay: RecordingSummary): boolean {
  return replay.pinned && me.me?.user_id !== undefined && replay.user_id === me.me.user_id
}

/** The value a column sorts on, normalized to a comparable string. */
function sortValue(replay: RecordingSummary, key: SortKey): string {
  switch (key) {
    case 'id':
      return replay.id
    case 'owner':
      return isBlindReplay(replay) ? '' : (replay.user_id ?? '')
    case 'season':
      return seasonText(replay)
    case 'outcome':
      return reasonText(replay.termination_reason)
    case 'created':
      return replay.created_at ?? ''
  }
}

const sortedReplays = computed(() => {
  if (replays.value === null) {
    return []
  }
  const { key, dir } = sort.value
  const factor = dir === 'asc' ? 1 : -1
  return [...replays.value].sort(
    (a, b) => factor * sortValue(a, key).localeCompare(sortValue(b, key)),
  )
})

/** Toggle direction when re-clicking the active column, else switch to it (descending first). */
function sortBy(key: SortKey): void {
  if (sort.value.key === key) {
    sort.value = { key, dir: sort.value.dir === 'asc' ? 'desc' : 'asc' }
  } else {
    sort.value = { key, dir: 'desc' }
  }
}

function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
  if (sort.value.key !== key) {
    return 'none'
  }
  return sort.value.dir === 'asc' ? 'ascending' : 'descending'
}

async function load(id: string): Promise<void> {
  replays.value = null
  await me.whenSettled()
  const [recordings, seasons, numbers] = await Promise.all([
    listRecordings({ env: id }).catch(() => [] as RecordingSummary[]),
    listSeasons(id, { includeUnreleased: me.me?.is_operator === true }).catch(
      () => [] as PublicSeasonView[],
    ),
    // Operators see real labels and never consult this, so the lookup is harmless for them.
    watchAgentNumbers(id).catch(() => ({}) as Record<string, number>),
  ])
  seasonsById.value = new Map(seasons.map((season) => [season.id, season]))
  anonymousNumbers.value = numbers
  replays.value = recordings
}

watch(envId, (id) => void load(id), { immediate: true })
</script>

<template>
  <section class="replays">
    <h1>Replays</h1>

    <UiEmptyState v-if="replays === null">Loading replays…</UiEmptyState>
    <UiEmptyState v-else-if="replays.length === 0">No replays yet.</UiEmptyState>
    <table v-else class="replays-table">
      <thead>
        <tr>
          <th scope="col" :aria-sort="ariaSort('id')">
            <button type="button" class="sort-head" @click="sortBy('id')">Replay</button>
          </th>
          <th scope="col">Players</th>
          <th scope="col" :aria-sort="ariaSort('owner')">
            <button type="button" class="sort-head" @click="sortBy('owner')">Owner</button>
          </th>
          <th scope="col" :aria-sort="ariaSort('season')">
            <button type="button" class="sort-head" @click="sortBy('season')">Season</button>
          </th>
          <th scope="col" :aria-sort="ariaSort('outcome')">
            <button type="button" class="sort-head" @click="sortBy('outcome')">Outcome</button>
          </th>
          <th scope="col" :aria-sort="ariaSort('created')">
            <button type="button" class="sort-head" @click="sortBy('created')">Created</button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="replay in sortedReplays" :key="replay.id">
          <td>
            <RouterLink class="replay-id" :to="`/replays/${replay.id}`">{{ displayId(replay) }}</RouterLink>
            <UiBadge v-if="showsPin(replay)" variant="accent">Pinned</UiBadge>
          </td>
          <td class="replay-players">{{ playersSummary(replay) }}</td>
          <td>{{ isBlindReplay(replay) ? '—' : (replay.user_id ?? '—') }}</td>
          <td>{{ seasonText(replay) }}</td>
          <td>{{ reasonText(replay.termination_reason) }}</td>
          <td>{{ formatDateOnly(replay.created_at) ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.replays h1 {
  margin: 0 0 var(--space-4);
}

.replays-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.replays-table th,
.replays-table td {
  text-align: left;
  padding: var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}

.replays-table th {
  color: var(--color-text-muted);
  font-weight: 600;
}

/* The header button is the sort control: a borderless button styled as the header label, so the
   whole cell is keyboard-operable without looking like a form control. */
.sort-head {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.sort-head:hover {
  color: var(--color-text);
}

.replays-table th[aria-sort='ascending'] .sort-head::after {
  content: ' ▲';
}

.replays-table th[aria-sort='descending'] .sort-head::after {
  content: ' ▼';
}

.replay-id {
  font-family: var(--font-mono);
  color: var(--color-text);
  transition: color var(--motion-fast) var(--ease-out);
}

.replay-id:hover {
  color: var(--color-accent);
}

.replay-players {
  color: var(--color-text-muted);
}
</style>
