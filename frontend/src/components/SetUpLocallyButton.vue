<script setup lang="ts">
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'

import type { SeasonSettings } from '../api/client.js'
import { cloneCommandFor, seasonSettingsFile } from '../lib/season-settings.js'
import UiButton from './ui/UiButton.vue'
import UiDialog from './ui/UiDialog.vue'

const props = defineProps<{
  meta: EnvironmentMeta
  settings: SeasonSettings
}>()

const open = ref(false)
const file = computed(() => seasonSettingsFile(props.meta, props.settings))
const cloneCommand = computed(() => cloneCommandFor(props.settings))

function downloadSettings(): void {
  if (file.value === null) return
  const href = URL.createObjectURL(
    new Blob([`${JSON.stringify(file.value, null, 2)}\n`], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = href
  link.download = 'season.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(href), 0)
}

function begin(): void {
  downloadSettings()
  open.value = true
}
</script>

<template>
  <UiButton variant="secondary" @click="begin"
    >Set Up Locally</UiButton
  >
  <UiDialog v-model:open="open" title="Set up this season on your computer">
    <ol class="setup-steps">
      <li>
        Clone the season template:
        <code>{{ cloneCommand }}</code>
      </li>
      <li v-if="file !== null">
        Move the downloaded <code>season.json</code> next to
        <code>manifest.json</code> in the cloned folder.
      </li>
      <li>
        Run <code>python -m sandbox play</code>
      </li>
    </ol>
    <p v-if="file !== null" class="setup-result">
      Every local run now uses {{ settings.season_label ?? settings.season_id }} settings. Delete
      <code>season.json</code> to return to the environment defaults.
    </p>
    <p class="setup-guide">
      Need more help? Read the
      <RouterLink to="/docs/students/getting-started">Getting Started guide</RouterLink>.
    </p>
    <div class="setup-actions">
      <UiButton variant="secondary" @click="open = false">Done</UiButton>
    </div>
  </UiDialog>
</template>

<style scoped>
.setup-steps {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding-left: var(--space-5);
}

.setup-steps code {
  display: block;
  margin-top: var(--space-1);
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}

.setup-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-5);
}

.setup-guide {
  margin: var(--space-4) 0 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.setup-result {
  margin: var(--space-4) 0 0;
}
</style>
