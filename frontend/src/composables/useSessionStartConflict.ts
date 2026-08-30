import { ref, watch } from 'vue'
import type { Router } from 'vue-router'

import { type StartSessionInput, startSession, stopSession } from '../api/client.js'
import { handleSessionStartResult, SESSION_START_FAILED_MESSAGE } from '../lib/session-start.js'

/**
 * The one-active-session conflict flow shared by every start surface (the play form and the
 * watch/rate picker). When a start returns `already_active`, the caller surfaces the conflict here
 * and renders SessionConflictDialog with this state; the viewer then explicitly returns to the
 * active session, replaces it with the pending request, or abandons the request by dismissing.
 */
export function useSessionStartConflict(router: Pick<Router, 'push'>) {
  const conflictOpen = ref(false)
  // The session the conflict is about. Null once that session was ended (or the dialog reset), so
  // the dialog only offers "Return" while there is still a live session to return to.
  const conflictActiveSessionId = ref<string | null>(null)
  const pendingStartInput = ref<StartSessionInput | null>(null)
  const replacing = ref(false)
  const conflictError = ref<string | null>(null)

  /** Dismissing the conflict abandons its pending request without reopening the start form. */
  watch(conflictOpen, (isOpen) => {
    if (!isOpen && !replacing.value) {
      conflictActiveSessionId.value = null
      pendingStartInput.value = null
      conflictError.value = null
    }
  })

  /** Open the confirmation for a rejected start, keeping an exact copy of the request to retry. */
  function surfaceConflict(input: StartSessionInput, activeSessionId: string): void {
    pendingStartInput.value = structuredClone(input)
    conflictActiveSessionId.value = activeSessionId
    conflictError.value = null
    conflictOpen.value = true
  }

  async function returnToActiveSession(): Promise<void> {
    const activeSessionId = conflictActiveSessionId.value
    if (activeSessionId === null || replacing.value) {
      return
    }
    conflictOpen.value = false
    await router.push(`/sessions/${activeSessionId}`)
  }

  /**
   * End the active session, then retry the exact pending request. When a previous attempt already
   * ended the active session but failed to start the new one, the stop step is skipped and only the
   * start is retried. A retry that hits another conflict re-arms the dialog for a fresh choice.
   */
  async function replaceActiveSession(): Promise<void> {
    const input = pendingStartInput.value
    if (input === null || replacing.value) {
      return
    }
    replacing.value = true
    conflictError.value = null

    const activeSessionId = conflictActiveSessionId.value
    if (activeSessionId !== null) {
      try {
        await stopSession(activeSessionId)
        // The active session is gone whatever the retry below does, so "Return" must go with it.
        conflictActiveSessionId.value = null
      } catch {
        conflictError.value = 'Could not end the active session. Please try again.'
        replacing.value = false
        return
      }
    }

    try {
      const resolution = await handleSessionStartResult(await startSession(input), router)
      if (resolution.kind === 'already_active') {
        conflictActiveSessionId.value = resolution.activeSessionId
        return
      }
      if (resolution.kind === 'error') {
        conflictError.value = resolution.message
      }
    } catch {
      conflictError.value = SESSION_START_FAILED_MESSAGE
    } finally {
      replacing.value = false
    }
  }

  return {
    conflictOpen,
    conflictActiveSessionId,
    replacing,
    conflictError,
    surfaceConflict,
    returnToActiveSession,
    replaceActiveSession,
  }
}
