import type { StepState } from '@game-sandbox/schema'
import { computed, type Ref, ref } from 'vue'

import { type ChatEntry, messageKey } from '../lib/chat.js'
import { type DecisionEntry, decisionEntries } from '../lib/state.js'
import { isCompletedOutcome, reasonText } from '../replay/reason.js'

interface LiveFramePresentationOptions {
  status: Readonly<Ref<'starting' | 'running' | 'ended'>>
  paused: Readonly<Ref<boolean>>
  endReason: Readonly<Ref<string | null>>
}

/**
 * Presentation state shared by live session hosts. The socket and renderer remain page-owned, while
 * this composable keeps their rendered chat, decisions, and status wording consistent.
 */
export function useLiveFramePresentation({
  status,
  paused,
  endReason,
}: LiveFramePresentationOptions) {
  const decisions = ref<DecisionEntry[]>([])
  const chatLog = ref<ChatEntry[]>([])
  const seenDecisions = new Set<string>()
  const seenMessages = new Set<string>()

  function appendDecisions(state: StepState): DecisionEntry[] {
    const appended: DecisionEntry[] = []
    for (const entry of decisionEntries(state)) {
      const key = `${entry.tick}\0${entry.player}`
      if (!seenDecisions.has(key)) {
        seenDecisions.add(key)
        decisions.value.push(entry)
        appended.push(entry)
      }
    }
    return appended
  }

  function appendMessages(state: StepState): void {
    for (const message of state.messages ?? []) {
      const entry: ChatEntry = { tick: state.tick, ...message }
      const key = messageKey(entry)
      if (!seenMessages.has(key)) {
        seenMessages.add(key)
        chatLog.value.push(entry)
      }
    }
  }

  const statusLabel = computed(() => {
    if (status.value === 'ended') {
      return reasonText(endReason.value)
    }
    if (paused.value) {
      return 'Paused'
    }
    return status.value === 'running' ? 'Live' : 'Starting…'
  })
  const statusTone = computed<'neutral' | 'success' | 'warning'>(() => {
    if (status.value === 'ended') {
      return 'neutral'
    }
    return paused.value ? 'warning' : status.value === 'running' ? 'success' : 'neutral'
  })
  const completedOutcome = computed(() => isCompletedOutcome(endReason.value))

  return {
    appendDecisions,
    appendMessages,
    chatLog,
    completedOutcome,
    decisions,
    statusLabel,
    statusTone,
  }
}
