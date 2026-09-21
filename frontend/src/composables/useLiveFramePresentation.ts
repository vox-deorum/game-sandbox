import type { StepState } from '@game-sandbox/schema'
import { computed, type Ref, ref } from 'vue'

import type { ConnectionState } from '../api/socket.js'
import { type ChatEntry, messageKey } from '../lib/chat.js'
import type { HealthVerdict } from '../lib/session-health.js'
import { type DecisionEntry, decisionEntries } from '../lib/state.js'
import { isCompletedOutcome, reasonText } from '../replay/reason.js'

interface LiveFramePresentationOptions {
  status: Readonly<Ref<'starting' | 'running' | 'ended'>>
  paused: Readonly<Ref<boolean>>
  endReason: Readonly<Ref<string | null>>
  connection: Readonly<Ref<ConnectionState>>
  /** Why the picture is standing still, measured from per-step timing. See lib/session-health.ts. */
  health: Readonly<Ref<HealthVerdict | null>>
}

/**
 * Presentation state shared by live session hosts. The socket and renderer remain page-owned, while
 * this composable keeps their rendered chat, decisions, and status wording consistent.
 */
export function useLiveFramePresentation({
  status,
  paused,
  endReason,
  connection,
  health,
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

  /**
   * The second badge, beside the status one: why the picture is standing still, or null when there is
   * nothing worth saying. A slow agent and a lost connection look identical on screen but want opposite
   * things from the viewer, so the transport answers first (it alone knows for certain that it dropped)
   * and the measured per-step timing answers only while the link is fine. A finished session says
   * nothing here; its outcome is the status badge's to report.
   */
  const healthBadge = computed<HealthVerdict | null>(() => {
    if (status.value === 'ended') {
      return null
    }
    if (connection.value === 'reconnecting') {
      return { label: 'Reconnecting…', tone: 'warning' }
    }
    return health.value
  })
  const healthLabel = computed(() => healthBadge.value?.label ?? null)
  const healthTone = computed(() => healthBadge.value?.tone ?? 'warning')

  return {
    appendDecisions,
    appendMessages,
    chatLog,
    completedOutcome,
    decisions,
    healthLabel,
    healthTone,
    statusLabel,
    statusTone,
  }
}
