import { ref } from 'vue'

/** The result shape every `authClient.admin.*` call returns: an `error` object or null. */
export interface TargetedActionResult {
  error: { message?: string } | null
}

/** What a confirm attempt did: succeeded, failed (error painted if still current), or was a no-op. */
export type ConfirmOutcome = 'success' | 'error' | 'skipped'

/**
 * The confirm-with-staleness pattern shared by the ban and reset-password dialogs.
 *
 * An admin action runs against one target row, but the dialog can be cancelled (without awaiting the
 * request) and reopened for the same or a different row before the first request resolves. This keeps
 * the in-flight request tied to its target id so that:
 *
 * - a second confirm for a target whose request is still running is refused, not duplicated
 *   (the `beginFor`/`busy` pair reflects that in-flight state when the dialog reopens on the same row);
 * - a resolved request only paints its error into the dialog when that row is still the one showing;
 * - a late-resolving request never clears the busy/in-flight state a newer request for another row owns.
 */
export function useTargetedAction(fallbackMessage: string) {
  const busy = ref(false)
  const error = ref<string | null>(null)
  // The id of the target whose request is currently in flight (null when idle). Deliberately not
  // cleared when the dialog reopens, so a duplicate confirm for a still-running target is refused.
  const inFlightId = ref<string | null>(null)

  /** Prepare the visible state for a freshly opened dialog; stay busy if this target is mid-flight. */
  function beginFor(targetId: string | null): void {
    error.value = null
    busy.value = inFlightId.value !== null && inFlightId.value === targetId
  }

  async function confirm(
    targetId: string,
    perform: () => Promise<TargetedActionResult>,
    isStillTarget: () => boolean,
  ): Promise<ConfirmOutcome> {
    if (busy.value || inFlightId.value === targetId) {
      return 'skipped'
    }
    busy.value = true
    inFlightId.value = targetId
    error.value = null
    try {
      const { error: err } = await perform()
      if (err) {
        if (isStillTarget()) {
          error.value = err.message ?? fallbackMessage
        }
        return 'error'
      }
      return 'success'
    } finally {
      // Only the request that still owns the in-flight slot clears it; a newer request for another
      // row (started after a cancel + reopen) has already taken ownership and must keep running.
      if (inFlightId.value === targetId) {
        inFlightId.value = null
        busy.value = false
      }
    }
  }

  return { busy, error, beginFor, confirm }
}
