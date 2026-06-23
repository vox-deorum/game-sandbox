<!--
  Seasons: the cross-game competition view, one row per public season, not per environment. A season
  appears here only when at least one of its three flags is public: released, accepting submissions,
  or open for play. The season is the subject; the environment is secondary context. This answers the
  student's first question ("what should I work on, and what just finished?") without first picking a
  game, and is no longer a clone of the home environment gallery.

  The card destination follows lifecycle priority: released results, then submissions, then play.
  Each active gate also has its own direct action tag. The backing read is a single `GET /api/seasons`.
-->
<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'

import { getEnvironments, listSeasons, type PublicSeasonView } from '../api/client.js'
import UiBadge from '../components/ui/UiBadge.vue'
import UiCard from '../components/ui/UiCard.vue'
import UiEmptyState from '../components/ui/UiEmptyState.vue'
import { currentUserId } from '../identity.js'
import { formatDate } from '../lib/format.js'
import { useMe } from '../me.js'
import { thumbnailFor } from '../renderers/registry.js'

const seasons = ref<PublicSeasonView[] | null>(null)
const environments = ref<Map<string, EnvironmentMeta>>(new Map())
const error = ref(false)
const me = useMe()
const ownerId = computed(() => me.me?.user_id ?? currentUserId)

onMounted(async () => {
  try {
    const [envs, publicSeasons] = await Promise.all([getEnvironments(), listSeasons()])
    environments.value = new Map(envs.map((meta: EnvironmentMeta) => [meta.env_id, meta]))
    seasons.value = publicSeasons
  } catch {
    error.value = true
  }
})

function seasonLabel(season: PublicSeasonView): string {
  return season.label ?? `Season ${season.id.slice(0, 8)}`
}

function envName(season: PublicSeasonView): string {
  return environments.value.get(season.env_id)?.display_name ?? season.env_id
}

function envThumbnail(season: PublicSeasonView): string {
  return thumbnailFor(environments.value.get(season.env_id)?.renderer ?? '')
}

/** An open submission or play window, the live competitions that lead the list. */
function isOpen(season: PublicSeasonView): boolean {
  return season.submission_status === 'open' || season.play_status === 'open'
}

function leaderboardLink(season: PublicSeasonView): string {
  return `/environments/${season.env_id}/leaderboards/${season.id}`
}

function submissionLink(season: PublicSeasonView): string {
  return `/environments/${season.env_id}/agents/${ownerId.value}`
}

function playLink(season: PublicSeasonView): string {
  const environmentPath = `/environments/${season.env_id}`
  return environments.value.get(season.env_id)?.human_slots.length
    ? `${environmentPath}?play=1`
    : `${environmentPath}#play`
}

/** Results take precedence, followed by the submission target and then the play target. */
function seasonLink(season: PublicSeasonView): string | null {
  if (season.release_status === 'released') {
    return leaderboardLink(season)
  }
  if (season.submission_status === 'open') {
    return submissionLink(season)
  }
  if (season.play_status === 'open') {
    return playLink(season)
  }
  return null
}

function metadataLine(season: PublicSeasonView): string {
  const parts: string[] = []
  if (season.released_at !== null) {
    parts.push(`Released at ${formatDate(season.released_at)}`)
  }
  parts.push(`${season.submission_count} Submissions`)
  parts.push(`${season.session_count} Sessions Played`)
  return parts.join(' · ')
}

/** Open seasons first (live action leads), then the released history; the API already sorts newest-first. */
const ordered = computed(() =>
  seasons.value === null
    ? []
    : [...seasons.value].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a))),
)
</script>

<template>
  <section class="seasons">
    <header class="seasons-intro">
      <h1>Seasons</h1>
      <p class="seasons-lede">Live competitions and released results across every environment.</p>
    </header>

    <UiEmptyState v-if="error" tone="danger">Could not load seasons.</UiEmptyState>
    <UiEmptyState v-else-if="seasons === null">Loading…</UiEmptyState>
    <UiEmptyState v-else-if="seasons.length === 0">No active or released seasons yet.</UiEmptyState>
    <ul v-else class="season-list">
      <li v-for="season in ordered" :key="season.id">
        <UiCard class="season-card" :interactive="seasonLink(season) !== null">
          <RouterLink
            v-if="seasonLink(season) !== null"
            class="season-card-link"
            :to="seasonLink(season) ?? ''"
            :aria-label="`Open ${seasonLabel(season)}`"
          />
          <div class="season-body">
            <div class="season-head">
              <span class="season-name">{{ seasonLabel(season) }}</span>
              <div class="season-actions">
                <RouterLink
                  v-if="season.submission_status === 'open'"
                  class="season-action"
                  :to="submissionLink(season)"
                >
                  <UiBadge variant="accent">Submissions open</UiBadge>
                </RouterLink>
                <RouterLink
                  v-if="season.play_status === 'open'"
                  class="season-action"
                  :to="playLink(season)"
                >
                  <UiBadge variant="accent">Play open</UiBadge>
                </RouterLink>
                <RouterLink
                  v-if="season.release_status === 'released'"
                  class="season-action"
                  :to="leaderboardLink(season)"
                >
                  <UiBadge>Results released</UiBadge>
                </RouterLink>
              </div>
            </div>
            <div class="season-env">Environment: {{ envName(season) }}</div>
            <div class="season-metadata">{{ metadataLine(season) }}</div>
          </div>
          <img class="season-thumb" :src="envThumbnail(season)" alt="" />
        </UiCard>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.seasons-intro {
  margin-bottom: var(--space-4);
}

.seasons-lede {
  margin: 0;
  color: var(--color-text-muted);
}

.season-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.season-card {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 160px;
  align-items: center;
  gap: var(--space-5);
}

.season-card-link {
  position: absolute;
  inset: 0;
  z-index: 1;
  border-radius: inherit;
}

.season-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-1);
}

.season-name {
  font-size: var(--text-lg);
  font-weight: 600;
}

.season-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.season-action {
  position: relative;
  z-index: 2;
  display: inline-flex;
}

.season-env {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.season-metadata {
  margin-top: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.season-thumb {
  display: block;
  width: 160px;
  max-width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  background: var(--color-surface-raised);
}

@media (max-width: 768px) {
  .season-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .season-thumb {
    width: 100%;
  }
}
</style>
