/**
 * The pin toggle with its busy and error state, currently duplicated verbatim between the session
 * end card and the replay page (see plans/stage-04.5/page-restructure.md). The caller owns when the
 * pin control is shown (ownership) and seeds the initial `pinned` value from the recording listing;
 * this composable owns the toggle, the in-flight guard, and the typed pinned-quota message.
 */
import { type MaybeRefOrGetter, ref, toValue } from 'vue'

import { pinRecording, unpinRecording } from '../api/client.js'

export function usePinning(recordingId: MaybeRefOrGetter<string | null>) {
  const pinned = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)

  async function toggle(): Promise<void> {
    const id = toValue(recordingId)
    if (id === null || busy.value) {
      return
    }
    busy.value = true
    error.value = null
    const result = pinned.value ? await unpinRecording(id) : await pinRecording(id)
    if (result.ok) {
      pinned.value = !pinned.value
    } else if (result.reason === 'pinned_quota') {
      error.value = 'You have reached your pinned-recording limit. Unpin an older one first.'
    } else {
      error.value = 'Could not update the pin.'
    }
    busy.value = false
  }

  return { pinned, busy, error, toggle }
}
