<!--
  The lifecycle controls of the operator console (Stage 6.7): the three independent gates a season
  carries — its submission window, its public-play window, and its release status — each shown as a
  badge with a single toggle button. Declaring a season leaves all three closed/unreleased, so the
  console makes clear these are three separate operator actions rather than one "publish".

  The one-open invariants surface as direct messages: opening submissions can hit
  `open_season_exists` (another season is already accepting submissions) and opening play can hit
  `open_play_season_exists` (another season is already the public play target). Releasing is the
  action that exposes the boards on the environment page; opening play is independent of release.
-->
<script setup lang="ts">
import { ref } from 'vue'

import {
  closePlay,
  closeSubmissions,
  type SeasonView,
  openPlay,
  openSubmissions,
  releaseSeason,
  unreleaseSeason,
} from '../../api/client.js'
import UiButton from '../ui/UiButton.vue'
import UiStatusBadge from '../ui/UiStatusBadge.vue'

const props = defineProps<{ season: SeasonView }>()
const emit = defineEmits<{ (e: 'changed', season: SeasonView): void }>()

const busy = ref<'submissions' | 'play' | 'release' | null>(null)
const error = ref<string | null>(null)

async function toggleSubmissions(): Promise<void> {
  busy.value = 'submissions'
  error.value = null
  try {
    if (props.season.submission_status === 'open') {
      emit('changed', await closeSubmissions(props.season.id))
    } else {
      const result = await openSubmissions(props.season.id)
      if (result.ok) {
        emit('changed', result.season)
      } else if (result.reason === 'open_season_exists') {
        error.value =
          'Another season is already accepting submissions. Close it before opening this one.'
      } else {
        error.value = 'Could not change the submission window.'
      }
    }
  } finally {
    busy.value = null
  }
}

async function togglePlay(): Promise<void> {
  busy.value = 'play'
  error.value = null
  try {
    if (props.season.play_status === 'open') {
      emit('changed', await closePlay(props.season.id))
    } else {
      const result = await openPlay(props.season.id)
      if (result.ok) {
        emit('changed', result.season)
      } else if (result.reason === 'open_play_season_exists') {
        error.value =
          'Another season is already open for public play. Close play on it before opening this one.'
      } else {
        error.value = 'Could not change the public-play window.'
      }
    }
  } finally {
    busy.value = null
  }
}

async function toggleRelease(): Promise<void> {
  busy.value = 'release'
  error.value = null
  try {
    const next =
      props.season.release_status === 'released'
        ? await unreleaseSeason(props.season.id)
        : await releaseSeason(props.season.id)
    emit('changed', next)
  } catch {
    error.value = 'Could not change the release status.'
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="lifecycle">
    <div class="gate">
      <UiStatusBadge
        :tone="season.release_status === 'released' ? 'success' : 'neutral'"
        :label="season.release_status === 'released' ? 'Released' : 'Unreleased'"
      />
      <UiButton
        variant="secondary"
        size="tight"
        :loading="busy === 'release'"
        @click="toggleRelease"
      >
        {{ season.release_status === 'released' ? 'Unrelease' : 'Release' }}
      </UiButton>
      <span class="gate-hint">Exposes the boards on the environment page.</span>
    </div>

    <div class="gate">
      <UiStatusBadge
        :tone="season.submission_status === 'open' ? 'success' : 'neutral'"
        :label="season.submission_status === 'open' ? 'Submissions open' : 'Submissions closed'"
      />
      <UiButton
        variant="secondary"
        size="tight"
        :loading="busy === 'submissions'"
        @click="toggleSubmissions"
      >
        {{ season.submission_status === 'open' ? 'Close submissions' : 'Open submissions' }}
      </UiButton>
    </div>

    <div class="gate">
      <UiStatusBadge
        :tone="season.play_status === 'open' ? 'success' : 'neutral'"
        :label="season.play_status === 'open' ? 'Play open' : 'Play closed'"
      />
      <UiButton variant="secondary" size="tight" :loading="busy === 'play'" @click="togglePlay">
        {{ season.play_status === 'open' ? 'Close play' : 'Open play' }}
      </UiButton>
      <span class="gate-hint">Allows public watch/play and rating writes, released or not.</span>
    </div>

    <p v-if="error" class="lifecycle-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.lifecycle {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.gate {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.gate-hint {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}

.lifecycle-error {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-danger);
}
</style>
