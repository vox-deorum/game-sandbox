<!--
  The environment's Replays tab: the readable recordings for this environment as a sortable table.
  The backend listing is open to everyone (read-only) and filtered to this environment, newest first;
  this page resolves each replay's season label and play state from the environment's season list and
  lets the viewer re-sort client-side. Submitted-agent attribution is masked for non-operators while
  that season remains playable. A row links to its `/replays/:id` viewer; the viewer's own pinned
  recording carries a text "Pinned" badge, so the pin signal is never a bare glyph.
-->
<script setup lang="ts">
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
import {
  type AttributionContext,
  hasSubmittedAgent,
  isBlindMasked,
  seatControllerLabel,
} from '../lib/attribution.js'
import { anonymityState, presentsMasked } from '../lib/anonymity.js'
import { formatDateOnly, formatSeasonName, formatSeat } from '../lib/format.js'
import { isAdmin, useMe, userId } from '../me.js'
import { isCompletedOutcome, reasonText } from '../replay/reason.js'

const route = useRoute()
const me = useMe()
const envId = computed(() => String(route.params.envId))

const replays = ref<RecordingSummary[] | null>(null)
/** season id → public season facts, used for labels and playable-season anonymity. */
const seasonsById = ref<Map<string, PublicSeasonView>>(new Map())
// Submission id → season-wide anonymous number for the env's play-open season (the only one a blind
// replay can belong to), so a masked row reads the same "Agent N" as the rating panel.
const anonymousNumbers = ref<Record<string, number>>({})

/** The sortable columns and the current sort. Default newest-first, matching the backend order. */
type SortKey = 'id' | 'owner' | 'season' | 'outcome' | 'created'
const sort = ref<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'created', dir: 'desc' })

/** This page's attribution context for `replay`, shared by the summary text and its tooltip so both
 *  honour the exact same blind test. */
function attributionCtx(replay: RecordingSummary): AttributionContext {
  return {
    blind: isBlindReplay(replay),
    viewerId: userId(me.me) ?? undefined,
    anonymousNumbers: anonymousNumbers.value,
  }
}

/**
 * A compact one-line summary of who played, one entry per seat. Seats rather than players because the
 * platform ranks seats: listing a wide seat's repeated agent once per position would read as several
 * competitors where the outcome column and the standings card both show one.
 */
function seatsSummary(replay: RecordingSummary): string {
  const { players, seats } = replay.header
  const ctx = attributionCtx(replay)
  const parts = Object.entries(seats).map(([seat, members]) => {
    const label = seatControllerLabel(members, players, ctx)
    // A masked human already reads as the bare neutral "Human" (attributionLabel's blind branch); the
    // "Human (name)" parenthetical only applies once the real name is showing. A seat is human when
    // any member is, which is the one the collapsed label leads with.
    const human = members.map((member) => players[member]).find((entry) => entry?.kind === 'human')
    const text = human !== undefined && !isBlindMasked(human, ctx) ? `Human (${label})` : label
    return `${formatSeat(seat)}: ${text}`
  })
  return parts.length > 0 ? parts.join(', ') : '—'
}

/** The stable ids behind `replay`'s seats, joined for a tooltip — omitted entirely for a blind replay,
 *  whose whole row hides identity, not just the display name. */
function playersTitle(replay: RecordingSummary): string | undefined {
  if (isBlindReplay(replay)) {
    return undefined
  }
  const ids = Object.values(replay.header.players)
    .map((player) => ('user' in player ? player.user : undefined))
    .filter((id): id is string => id !== undefined)
  return ids.length > 0 ? ids.join(', ') : undefined
}

/** Show only the final hyphen-delimited section while the link keeps the complete recording id. */
function displayId(replay: RecordingSummary): string {
  const section = replay.id.split('-').at(-1)
  return section === undefined || section === '' ? replay.id : section
}

/** Name a unique multiplayer winner for completed play, otherwise retain the termination label. */
function outcomeText(replay: RecordingSummary): string {
  if (isCompletedOutcome(replay.termination_reason)) {
    if (replay.winner_id === -1) {
      return 'Tied'
    }
    if (typeof replay.winner_id === 'string') {
      return `${formatSeat(replay.winner_id)} won`
    }
  }
  return reasonText(replay.termination_reason)
}

function seasonText(replay: RecordingSummary): string {
  if (replay.season_id === null) {
    return '—'
  }
  const season = seasonsById.value.get(replay.season_id)
  return season === undefined ? '—' : formatSeasonName(season)
}

function replayAnonymityState(replay: RecordingSummary) {
  const season = replay.season_id === null ? undefined : seasonsById.value.get(replay.season_id)
  return anonymityState({
    identityResolved: !me.loading,
    operator: isAdmin(me.me),
    seasonPlayable:
      replay.season_id === null ? false : season === undefined ? null : season.play_status === 'open',
    hasSubmittedAgent: hasSubmittedAgent(replay.header.players),
  })
}

function isBlindReplay(replay: RecordingSummary): boolean {
  return presentsMasked(replayAnonymityState(replay))
}

/** Show a pin badge only on the viewer's own pinned recordings. */
function showsPin(replay: RecordingSummary): boolean {
  const uid = userId(me.me)
  return replay.pinned && uid != null && replay.user_id === uid
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
      return outcomeText(replay)
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
  const [recordings, seasons] = await Promise.all([
    listRecordings({ env: id }).catch(() => [] as RecordingSummary[]),
    listSeasons(id, { includeUnreleased: isAdmin(me.me) }).catch(
      () => [] as PublicSeasonView[],
    ),
  ])
  seasonsById.value = new Map(seasons.map((season) => [season.id, season]))
  anonymousNumbers.value = {}
  if (recordings.some((replay) => replayAnonymityState(replay) === 'masked')) {
    anonymousNumbers.value = await watchAgentNumbers(id).catch(() => ({}))
  }
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
          <th scope="col" :aria-sort="ariaSort('owner')">
            <button type="button" class="sort-head" @click="sortBy('owner')">Owner</button>
          </th>
          <th scope="col" :aria-sort="ariaSort('id')">
            <button type="button" class="sort-head" @click="sortBy('id')">Replay</button>
          </th>
          <th scope="col">Seats</th>
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
          <td :title="isBlindReplay(replay) ? undefined : (replay.user_id ?? undefined)">
            {{ isBlindReplay(replay) ? '—' : (replay.user_name ?? replay.user_id ?? '—') }}
          </td>
          <td>
            <RouterLink class="replay-id" :to="`/replays/${replay.id}`">{{ displayId(replay) }}</RouterLink>
            <UiBadge v-if="showsPin(replay)" variant="accent">Pinned</UiBadge>
          </td>
          <td class="replay-seats" :title="playersTitle(replay)">{{ seatsSummary(replay) }}</td>
          <td>{{ seasonText(replay) }}</td>
          <td>{{ outcomeText(replay) }}</td>
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

.replay-seats {
  color: var(--color-text-muted);
}
</style>
