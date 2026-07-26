/**
 * Shared turn-authoritative chat state for live web and local sessions.
 *
 * The latest state declares the sender, tick, and recipient policy. Sending that player's action
 * consumes the browser opportunity immediately, while the next declared sender and tick reopen it.
 */
import type { StepState } from '@game-sandbox/schema'
import type { Command } from '@game-sandbox/schema/protocol'
import { computed, type Ref, ref } from 'vue'

export interface LiveChatPayload {
  sender: string
  tick: number
  to: string | null
  text: string
}

interface LiveChatOptions {
  state: Readonly<Ref<StepState | null>>
  controlledPlayers: Readonly<Ref<readonly string[]>>
  enabled: Readonly<Ref<boolean>>
  send(command: Command): void
}

export function useLiveChat(options: LiveChatOptions) {
  const chatOptions = computed(() => options.state.value?.chat_options ?? null)
  const consumedOpportunity = ref<string | null>(null)
  const opportunityKey = computed(() => {
    const policy = chatOptions.value
    const state = options.state.value
    return policy === null || state === null ? null : `${policy.sender}:${state.tick}`
  })

  const chatSendable = computed(() => {
    const policy = chatOptions.value
    const state = options.state.value
    const key = opportunityKey.value
    return (
      options.enabled.value &&
      state !== null &&
      !state.overlay?.terminal &&
      policy !== null &&
      options.controlledPlayers.value.includes(policy.sender) &&
      key !== null &&
      consumedOpportunity.value !== key
    )
  })

  function consumeAction(playerId: string): void {
    if (chatOptions.value?.sender === playerId) {
      consumedOpportunity.value = opportunityKey.value
    }
  }

  function sendChat(payload: LiveChatPayload): void {
    options.send({
      kind: 'chat',
      player: payload.sender,
      tick: payload.tick,
      to: payload.to,
      text: payload.text,
    })
  }

  return {
    chatOptions,
    chatSendable,
    consumeAction,
    sendChat,
  }
}
