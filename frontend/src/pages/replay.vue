<!--
  The replay viewer: load a recording by URL, then play, pause, step, and scrub it through the same
  renderer live play uses. The recording is fetched as JSONL and parsed in the browser (the schema
  package's Ajv reader is Node-only); a header version this viewer does not understand becomes a
  friendly "needs a newer viewer" message. The transport is a plain controller over the state array,
  and the renderer's purity rule makes every control the same call — render the state under the index.

  The viewer is draw-only by construction: the renderer mounts with no sendAction and no controlled
  slots. The pin toggle appears when the signed-in user owns the recording, so pinning is reachable
  after the session page is gone.
-->
<script setup lang="ts">
import type { RecordingHeader } from '@game-sandbox/schema'
import type { EnvironmentMeta } from '@game-sandbox/schema/environment'
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'

import {
  getEnvironments,
  getRecording,
  listRecordings,
  pinRecording,
  unpinRecording,
} from '../api/client.js'
import { useMe } from '../me.js'
import { getRenderer } from '../renderers/registry.js'
import type { RendererInstance } from '../renderers/types.js'
import { parseRecording, UnsupportedVersionError } from '../replay/parse.js'
import { ReplayTransport, type ReplayState } from '../replay/transport.js'

const route = useRoute()
const me = useMe()
const id = String(route.params.id)

const loading = ref(true)
const loadError = ref(false)
const versionMessage = ref<string | null>(null)
const noRenderer = ref(false)
const header = ref<RecordingHeader | null>(null)

const replayState = ref<ReplayState>({ index: 0, total: 0, playing: false, tick: null })

const owned = ref(false)
const pinned = ref(false)
const pinBusy = ref(false)
const pinError = ref<string | null>(null)

const hostEl = ref<HTMLElement | null>(null)
const rendererInstance = shallowRef<RendererInstance | null>(null)
const transport = shallowRef<ReplayTransport | null>(null)

onMounted(async () => {
  let text: string
  try {
    text = await getRecording(id)
  } catch {
    loadError.value = true
    loading.value = false
    return
  }

  let parsed: ReturnType<typeof parseRecording>
  try {
    parsed = parseRecording(text)
  } catch (error) {
    if (error instanceof UnsupportedVersionError) {
      versionMessage.value = error.message
    } else {
      loadError.value = true
    }
    loading.value = false
    return
  }
  header.value = parsed.header
  loading.value = false

  const meta: EnvironmentMeta | undefined = (await getEnvironments().catch(() => [])).find(
    (e) => e.env_id === parsed.header.environment,
  )
  const module = meta === undefined ? undefined : getRenderer(meta.renderer)
  if (meta === undefined || module === undefined || hostEl.value === null) {
    noRenderer.value = true
    return
  }

  rendererInstance.value = module.mount({
    container: hostEl.value,
    meta,
    header: parsed.header,
    controlledSlots: [],
  })

  transport.value = new ReplayTransport(parsed.states, {
    paceIntervalMs: meta.pace_interval_ms,
    onFrame: (state) => rendererInstance.value?.render(state),
    onChange: (state) => {
      replayState.value = state
    },
  })

  // A `?t=⟨tick⟩` deep link seeks on load, so a moment inside a replay is linkable, not just the replay.
  const tParam = Number(route.query.t)
  if (route.query.t !== undefined && Number.isFinite(tParam)) {
    transport.value.seekToTick(tParam)
  } else {
    transport.value.renderCurrent()
  }

  // Determine ownership and the current pin state from the merged listing.
  const listing = await listRecordings({ env: parsed.header.environment }).catch(() => [])
  const entry = listing.find((r) => r.id === id)
  if (entry !== undefined && me.me?.user_id !== undefined && entry.user_id === me.me.user_id) {
    owned.value = true
    pinned.value = entry.pinned
  }
})

onBeforeUnmount(() => {
  transport.value?.destroy()
  rendererInstance.value?.destroy()
})

function onScrub(event: Event): void {
  transport.value?.seek(Number((event.target as HTMLInputElement).value))
}

async function togglePin(): Promise<void> {
  if (pinBusy.value) {
    return
  }
  pinBusy.value = true
  pinError.value = null
  const result = pinned.value ? await unpinRecording(id) : await pinRecording(id)
  if (result.ok) {
    pinned.value = !pinned.value
  } else if (result.reason === 'pinned_quota') {
    pinError.value = 'You have reached your pinned-recording limit. Unpin an older one first.'
  } else {
    pinError.value = 'Could not update the pin.'
  }
  pinBusy.value = false
}
</script>

<template>
  <p v-if="loading" class="status">Loading replay…</p>
  <p v-else-if="loadError" class="status">Could not load this replay.</p>
  <p v-else-if="versionMessage !== null" class="status">
    This replay needs a newer viewer. {{ versionMessage }}
  </p>
  <section v-else class="replay">
    <h1>Replay</h1>
    <p class="status">
      <code>{{ id }}</code><span v-if="header"> · {{ header.environment }}</span>
    </p>

    <div class="renderer-host" ref="hostEl" />
    <p v-if="noRenderer" class="status">No renderer is registered for this environment.</p>

    <div v-if="transport !== null" class="replay-controls">
      <button type="button" @click="transport?.stepBack()" :disabled="replayState.index === 0">
        ◀ Step
      </button>
      <button type="button" @click="transport?.toggle()">
        {{ replayState.playing ? 'Pause' : 'Play' }}
      </button>
      <button
        type="button"
        @click="transport?.stepForward()"
        :disabled="replayState.index >= replayState.total - 1"
      >
        Step ▶
      </button>
      <input
        class="scrubber"
        type="range"
        min="0"
        :max="Math.max(0, replayState.total - 1)"
        :value="replayState.index"
        @input="onScrub"
      />
      <span class="replay-position">
        tick {{ replayState.tick ?? 0 }} · {{ replayState.index + 1 }}/{{ replayState.total }}
      </span>
    </div>

    <div v-if="owned" class="replay-pin">
      <button type="button" @click="togglePin" :disabled="pinBusy">
        {{ pinned ? 'Pinned ✓' : 'Pin this recording' }}
      </button>
      <p v-if="pinError !== null" class="error">{{ pinError }}</p>
    </div>
  </section>
</template>
